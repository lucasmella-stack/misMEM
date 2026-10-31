// Owns what counts as a pending episode and the queries over it, which the viewer and
// the Engram aliases read through.
import type { Database as DB } from "better-sqlite3";

export interface PendingEpisode {
  id: string;
  scope: string;
  text: string;
  created_at: number;
  consolidated_into: string | null;
}

// The viewer's pending list and engram mem_context must agree on what "pending" and
// "newest first" mean, so both read through these two.
const PENDING_WHERE = "consolidated_into IS NULL AND (@scope IS NULL OR scope = @scope)";

export function countPendingEpisodes(db: DB, scope: string | null): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM episodes WHERE ${PENDING_WHERE}`).get({ scope }) as { n: number }
  ).n;
}

/** Unconsolidated episodes, newest first; rowid breaks ties between the same millisecond. */
export function pendingEpisodes(db: DB, scope: string | null, limit: number, offset = 0): PendingEpisode[] {
  return db
    .prepare(
      `SELECT id, scope, body AS text, created_at, consolidated_into
       FROM episodes
       WHERE ${PENDING_WHERE}
       ORDER BY created_at DESC, rowid DESC LIMIT @limit OFFSET @offset`,
    )
    .all({ scope, limit, offset }) as PendingEpisode[];
}
