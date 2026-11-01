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
  return db
    .prepare(
      `SELECT id, scope, name AS text, strength, polarity, created_at, updated_at
       FROM traits
       WHERE (@scope IS NULL OR scope = @scope)
       ORDER BY strength DESC, updated_at DESC LIMIT @limit`,
    )
    .all({ scope, limit }) as RecentTrait[];
}
