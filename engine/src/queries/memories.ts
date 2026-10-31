// The memory list and detail of the viewer: one memory with what it came from, what cites it
// and how many episodes `forget` left alive. Also the existence check the actions ask first,
// so the dispatcher never guesses whether an id names a memory or a trait.
import type { Database as DB } from "better-sqlite3";
import { parseIds } from "./relations.js";
import { memoryView, traitView, type MemoryView, type TraitView } from "./views.js";
import {
  excludeNoiseSql,
  MEMORY_COLUMNS,
  type EpisodeRow,
  type MemoryRow,
  type TraitRow,
} from "../store/rows.js";

export interface MemoryListQuery {
  scope: string | null;
  withNoise: boolean;
  limit: number;
  offset: number;
  at: number;
}

interface MemoryListItem extends MemoryView {
  sources: number;
  episodes_left: number;
  traits: number;
}

export interface MemoryList {
  total: number;
  memories: MemoryListItem[];
}

function countBy(db: DB, sql: string): Map<string, number> {
  const rows = db.prepare(sql).all() as Array<{ key: string; n: number }>;
  return new Map(rows.map((r) => [r.key, r.n]));
}

/** How many traits cite each memory. */
function traitCounts(db: DB): Map<string, number> {
  return countBy(
    db,
    `SELECT j.value AS key, COUNT(*) AS n
     FROM traits t, json_each(t.evidence_memory_ids) j GROUP BY j.value`,
  );
}

/** How many episodes remain tied to each memory (forget already deleted the rest). */
function episodeCounts(db: DB): Map<string, number> {
  return countBy(
    db,
    `SELECT consolidated_into AS key, COUNT(*) AS n
     FROM episodes WHERE consolidated_into IS NOT NULL GROUP BY consolidated_into`,
  );
}

export function listMemories(db: DB, query: MemoryListQuery): MemoryList {
  const rows = db
    .prepare(
      `SELECT ${MEMORY_COLUMNS} FROM memories m
       WHERE (@scope IS NULL OR scope = @scope) ${query.withNoise ? "" : `AND ${excludeNoiseSql("m")}`}`,
    )
    .all({ scope: query.scope }) as MemoryRow[];
  const traits = traitCounts(db);
  const episodes = episodeCounts(db);
  const memories = rows
    .map((row) => ({
      ...memoryView(row, query.at),
      sources: parseIds(row.source_episode_ids).length,
      episodes_left: episodes.get(row.id) ?? 0,
      traits: traits.get(row.id) ?? 0,
    }))
    // By today's salience, like recall; on a tie, the newest first.
    .sort((a, b) => b.salience - a.salience || b.created_at - a.created_at || a.id.localeCompare(b.id));

  return { total: memories.length, memories: memories.slice(query.offset, query.offset + query.limit) };
}

type OriginEpisode =
  | { id: string; missing: true }
  | { id: string; scope: string; text: string; created_at: number; linked_here: boolean };

export interface MemoryDetail {
  memory: MemoryView;
  episodes: OriginEpisode[];
  traits: TraitView[];
}

export function memoryDetail(db: DB, id: string, at: number): MemoryDetail | null {
  const row = db.prepare(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE id = ?`).get(id) as MemoryRow | undefined;
  if (!row) return null;

  // The sources the memory declares and those still pointing at it; one that forget already
  // deleted stays marked instead of vanishing from the chain.
  const getEpisode = db.prepare(
    "SELECT id, scope, body, created_at, consolidated_into FROM episodes WHERE id = ?",
  );
  const declared = parseIds(row.source_episode_ids);
  const linked = db
    .prepare("SELECT id FROM episodes WHERE consolidated_into = ? ORDER BY created_at")
    .all(id) as Array<{ id: string }>;
  const ids = [...new Set([...declared, ...linked.map((e) => e.id)])];
  const episodes = ids.map((episodeId): OriginEpisode => {
    const e = getEpisode.get(episodeId) as EpisodeRow | undefined;
    if (!e) return { id: episodeId, missing: true as const };
    return {
      id: e.id,
      scope: e.scope,
      text: e.body,
      created_at: e.created_at,
      // An episode re-consolidated into another memory stays in the list, but it shows.
      linked_here: e.consolidated_into === id,
    };
  });

  const traits = (
    db
      .prepare(
        `SELECT DISTINCT t.id, t.scope, t.name, t.strength, t.polarity, t.evidence_memory_ids,
                t.created_at, t.updated_at
         FROM traits t, json_each(t.evidence_memory_ids) j WHERE j.value = ?
         ORDER BY t.strength DESC, t.updated_at DESC`,
      )
      .all(id) as TraitRow[]
  ).map(traitView);

  return { memory: memoryView(row, at), episodes, traits };
}

/** The scopes of some memories: what validates that a trait's evidence exists in its scope. */
export function memoryScopes(db: DB, ids: readonly string[]): Array<{ id: string; scope: string }> {
  return db
    .prepare("SELECT id, scope FROM memories WHERE id IN (SELECT value FROM json_each(?))")
    .all(JSON.stringify(ids)) as Array<{ id: string; scope: string }>;
}

const EXISTS_SQL = {
  memory: "SELECT 1 FROM memories WHERE id = ?",
  trait: "SELECT 1 FROM traits WHERE id = ?",
} as const;

/** Existence check the viewer runs before choosing what to do with an id. */
export function entityExists(db: DB, layer: "memory" | "trait", id: string): boolean {
  return db.prepare(EXISTS_SQL[layer]).get(id) !== undefined;
}
