// The last rows of a layer, as /api/recent prints them. The pending-episode page is not here:
// it belongs to `memory/pending.ts`, which the Engram aliases read through as well.
import type { Database as DB } from "better-sqlite3";
import type { Layer } from "../schema.js";

interface RecentEpisode {
  id: string;
  scope: string;
  text: string;
  created_at: number;
  consolidated_into: string | null;
}

interface RecentMemory {
  id: string;
  scope: string;
  text: string;
  details: string | null;
  salience: number;
  created_at: number;
  last_accessed_at: number | null;
}

interface RecentTrait {
  id: string;
  scope: string;
  text: string;
  strength: number;
  polarity: string;
  created_at: number;
  updated_at: number;
}

export type RecentRow = RecentEpisode | RecentMemory | RecentTrait;

export interface TraitPage {
  rows: RecentTrait[];
  total: number;
}

/**
 * One page of traits with the total behind it: the client pages with the total, which is how it
 * tells "nothing else" from "on the next page". `id` breaks the tie because traits crystallized
 * in the same millisecond share strength and updated_at, and a partial order repeats rows.
 */
export function traitPage(db: DB, scope: string | null, limit: number, offset: number): TraitPage {
  const { n: total } = db
    .prepare("SELECT COUNT(*) AS n FROM traits WHERE (@scope IS NULL OR scope = @scope)")
    .get({ scope }) as { n: number };
  const rows = db
    .prepare(
      `SELECT id, scope, name AS text, strength, polarity, created_at, updated_at
       FROM traits
       WHERE (@scope IS NULL OR scope = @scope)
       ORDER BY strength DESC, updated_at DESC, id DESC LIMIT @limit OFFSET @offset`,
    )
    .all({ scope, limit, offset }) as RecentTrait[];
  return { rows, total };
}

export function recentRows(db: DB, layer: Layer, scope: string | null, limit: number): RecentRow[] {
  if (layer === "episode") {
    return db
      .prepare(
        `SELECT id, scope, body AS text, created_at, consolidated_into
         FROM episodes
         WHERE (@scope IS NULL OR scope = @scope)
         ORDER BY created_at DESC, rowid DESC LIMIT @limit`,
      )
      .all({ scope, limit }) as RecentEpisode[];
  }
  if (layer === "memory") {
    return db
      .prepare(
        `SELECT id, scope, gist AS text, details, salience, created_at, last_accessed_at
         FROM memories
         WHERE (@scope IS NULL OR scope = @scope)
         ORDER BY salience DESC, created_at DESC LIMIT @limit`,
      )
      .all({ scope, limit }) as RecentMemory[];
  }
  return traitPage(db, scope, limit, 0).rows;
}
