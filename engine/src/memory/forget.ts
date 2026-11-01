// Owns `forget`: what the cutoffs would delete, and the deletion itself.
import type { Database as DB } from "better-sqlite3";
import { ForgetInput } from "../schema.js";
import { decayMemories, effectiveSalience } from "./salience.js";
import type { SalienceRow } from "../store/rows.js";

export function forget(
  db: DB,
  raw: unknown,
): {
  episodes_to_delete: number;
  memories_to_delete: number;
  dry_run: boolean;
} {
  const input = ForgetInput.parse(raw);
  const at = Date.now();
  const cutoff = at - input.before_days * 86_400_000;
  const memoryCutoff = at - input.memory_grace_days * 86_400_000;
  const scopeWhere = input.scope ? "AND scope = @scope" : "";
  const memoryScopeWhere = input.scope ? "AND m.scope = @scope" : "";
  // A memory is only forgettable once every episode still linked to it is past
  // before_days: forgetting it deletes those episodes too (ON DELETE SET NULL
  // would otherwise re-queue them for consolidation), so one newer episode keeps
  // the whole memory alive.
  const memoryRows = db
    .prepare(
      `SELECT m.id, m.salience, m.created_at, m.last_accessed_at, m.salience_updated_at
       FROM memories m
       WHERE m.created_at <= @memoryCutoff ${memoryScopeWhere}
         AND NOT EXISTS (
           SELECT 1 FROM episodes e
           WHERE e.consolidated_into = m.id
             AND e.created_at >= @cutoff
         )`,
    )
    .all({
      memoryCutoff,
      cutoff,
      scope: input.scope,
    }) as Array<SalienceRow & { id: string }>;
  const memoryIds = memoryRows
    .filter(
      (row) => effectiveSalience(row, at) < input.salience_below,
    )
    .map((row) => row.id);

  const episodeIds = new Set(
    (
      db
        .prepare(
          `SELECT id FROM episodes
           WHERE consolidated_into IS NOT NULL
             AND created_at < @cutoff ${scopeWhere}`,
        )
        .all({ cutoff, scope: input.scope }) as Array<{ id: string }>
    ).map((row) => row.id),
  );
  const linkedEpisodes = db.prepare(
    "SELECT id FROM episodes WHERE consolidated_into = ?",
  );
  for (const memoryId of memoryIds) {
    const rows = linkedEpisodes.all(memoryId) as Array<{ id: string }>;
    for (const row of rows) episodeIds.add(row.id);
  }

  if (!input.dry_run) {
    db.transaction(() => {
      decayMemories(db, { scope: input.scope, at });
      const deleteOldEpisodes = db.prepare(
        `DELETE FROM episodes
         WHERE consolidated_into IS NOT NULL
           AND created_at < @cutoff ${scopeWhere}`,
      );
      deleteOldEpisodes.run({ cutoff, scope: input.scope });
      const deleteLinkedEpisodes = db.prepare(
        "DELETE FROM episodes WHERE consolidated_into = ?",
      );
      const deleteMemory = db.prepare("DELETE FROM memories WHERE id = ?");
      for (const memoryId of memoryIds) {
        deleteLinkedEpisodes.run(memoryId);
        deleteMemory.run(memoryId);
      }
    })();
  }

  return {
    episodes_to_delete: episodeIds.size,
    memories_to_delete: memoryIds.length,
    dry_run: input.dry_run,
  };
}
