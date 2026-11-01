// Row shapes of episodes, memories and traits, typed from SCHEMA (db.ts) and shared by every
// reader, so two copies cannot disagree on a column or its nullability.
import { NOISE_GIST_PREFIXES } from "../domain/noise.js";

export interface SalienceRow {
  salience: number;
  created_at: number;
  last_accessed_at: number | null;
  salience_updated_at: number | null;
}

export interface MemoryRow extends SalienceRow {
  id: string;
  scope: string;
  gist: string;
  details: string | null;
  source_episode_ids: string;
  use_count: number;
}

export interface TraitRow {
  id: string;
  scope: string;
  name: string;
  strength: number;
  polarity: string;
  evidence_memory_ids: string;
  created_at: number;
  updated_at: number;
}

export interface EpisodeRow {
  id: string;
  scope: string;
  body: string;
  created_at: number;
  consolidated_into: string | null;
}

/** An episode read through its memory link: the query's join or IN filter rules out null. */
export type ConsolidatedEpisodeRow = EpisodeRow & { consolidated_into: string };

export const MEMORY_COLUMNS =
  "id, scope, gist, details, source_episode_ids, salience, use_count, created_at, last_accessed_at, salience_updated_at";

/** What a row needs to be ranked by effective salience and drawn as a node, and nothing else. */
export type MemoryNodeRow = SalienceRow & { id: string; scope: string; gist: string };

/**
 * The graph ranks every memory of the scope before cutting to its cap, so it reads the whole
 * table on each request. Asking for `details` there made the peak grow with the text of the
 * base instead of with the answer, and the node only ever shows a trimmed `gist`.
 */
export const MEMORY_NODE_COLUMNS =
  "id, scope, gist, salience, created_at, last_accessed_at, salience_updated_at";

/**
 * Condition that leaves out the noise markers. `alias` is the `memories` table.
 * The prefixes are module constants, not external input; in SQLite LIKE only `%`
 * and `_` are wildcards, so `[` is literal.
 */
export function excludeNoiseSql(alias: string): string {
  return NOISE_GIST_PREFIXES.map((prefix) => `${alias}.gist NOT LIKE '${prefix}%'`).join(
    " AND ",
  );
}
