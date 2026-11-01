// The reads behind the Obsidian export: memories, traits, the episodes that fed them and every
// scope in the database. Scope note names count collisions across the whole base, so the last
// read deliberately ignores the export's own --scope filter.
import type { Database as DB } from "better-sqlite3";
import { excludeNoiseSql, type ConsolidatedEpisodeRow, type MemoryRow, type TraitRow } from "../store/rows.js";

/** The columns the export selects: `source_episode_ids` is not needed here. */
type ExportMemoryRow = Omit<MemoryRow, "source_episode_ids">;
type ExportTraitRow = Omit<TraitRow, "created_at">;

export function exportMemories(db: DB, scope?: string): ExportMemoryRow[] {
  return db
    .prepare(
      `SELECT id, scope, gist, details, salience, created_at, last_accessed_at, salience_updated_at
       FROM memories m WHERE (@scope IS NULL OR scope = @scope) AND ${excludeNoiseSql("m")}`,
    )
    .all({ scope: scope ?? null }) as ExportMemoryRow[];
}

export function exportTraits(db: DB, scope?: string): ExportTraitRow[] {
  return db
    .prepare(
      `SELECT id, scope, name, strength, polarity, evidence_memory_ids, updated_at
       FROM traits WHERE (@scope IS NULL OR scope = @scope)`,
    )
    .all({ scope: scope ?? null }) as ExportTraitRow[];
}

export function consolidatedEpisodes(db: DB, memoryIds: readonly string[]): ConsolidatedEpisodeRow[] {
  return db
    .prepare(
      `SELECT e.id, e.scope, e.body, e.created_at, e.consolidated_into FROM episodes e
       WHERE e.consolidated_into IN (SELECT value FROM json_each(?)) ORDER BY e.created_at`,
    )
    .all(JSON.stringify(memoryIds)) as ConsolidatedEpisodeRow[];
}

/** Every scope the export can name, noise excluded, in no particular order. */
export function exportScopes(db: DB): string[] {
  return (
    db
      .prepare(`SELECT scope FROM memories m WHERE ${excludeNoiseSql("m")} UNION SELECT scope FROM traits`)
      .all() as Array<{ scope: string }>
  ).map((row) => row.scope);
}
