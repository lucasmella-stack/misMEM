// Owns `consolidate`: one memory from its source episodes, in a single transaction.
import type { Database as DB } from "better-sqlite3";
import { ulid } from "ulid";
import { ConsolidateInput } from "../schema.js";

export function consolidate(
  db: DB,
  raw: unknown,
): { memory_id: string; consolidated: number } {
  const input = ConsolidateInput.parse(raw);
  const id = ulid();
  const ts = Date.now();
  const sourceJson = JSON.stringify(input.source_episode_ids);

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO memories (
         id, scope, gist, details, source_episode_ids, salience, created_at,
         salience_updated_at
       )
       VALUES (?, ?, ?, ?, ?, 1.0, ?, ?)`,
    ).run(
      id,
      input.scope,
      input.gist,
      input.details ?? null,
      sourceJson,
      ts,
      ts,
    );

    const placeholders = input.source_episode_ids.map(() => "?").join(",");
    // Pending and in scope, like the nightly run: without this an episode another memory already
    // owns would move to the new one and leave the old memory with no episodes behind it.
    const upd = db.prepare(
      `UPDATE episodes SET consolidated_into = ?
       WHERE id IN (${placeholders}) AND scope = ? AND consolidated_into IS NULL`,
    );
    const result = upd.run(id, ...input.source_episode_ids, input.scope);
    // Throwing rolls the INSERT back: a memory with no episodes has nothing it could have come from.
    if (result.changes === 0) {
      throw new Error(
        `ninguno de los ${input.source_episode_ids.length} episodios indicados está pendiente en el ámbito «${input.scope}»: puede que ya estén consolidados, que sean de otro ámbito o que no existan`,
      );
    }
    return result.changes;
  });

  const consolidated = tx();
  return { memory_id: id, consolidated };
}
