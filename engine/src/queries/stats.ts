// The read queries behind /api/stats and the stats command of both CLIs. Each caller prints a
// different shape, so they keep one function each instead of a shared shape and three mappers.
import type { Database as DB } from "better-sqlite3";

export interface ViewerStats {
  counts: { episodes: number; memories: number; traits: number; consolidated: number };
  topScopes: Array<{ scope: string; n: number }>;
  last: { id: string; scope: string; created_at: number } | null;
}

export function viewerStats(db: DB): ViewerStats {
  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  const topScopes = db
    .prepare(
      `SELECT scope, COUNT(*) AS n FROM episodes
       GROUP BY scope ORDER BY n DESC LIMIT 10`,
    )
    .all() as Array<{ scope: string; n: number }>;
  const last = db
    .prepare(
      "SELECT id, scope, created_at FROM episodes ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .get() as { id: string; scope: string; created_at: number } | undefined;
  return {
    counts: {
      episodes: count("SELECT COUNT(*) AS n FROM episodes"),
      memories: count("SELECT COUNT(*) AS n FROM memories"),
      traits: count("SELECT COUNT(*) AS n FROM traits"),
      consolidated: count("SELECT COUNT(*) AS n FROM episodes WHERE consolidated_into IS NOT NULL"),
    },
    topScopes,
    last: last ?? null,
  };
}

export interface StatsSummary {
  episodes_total: number;
  episodes_unconsolidated: number;
  memories_total: number;
  traits_total: number;
  scopes: Array<{ scope: string; count: number }>;
  oldest_episode_ts: number | null;
  newest_episode_ts: number | null;
}

/** `scopePrefix` filters with LIKE, as the `--scope` flag of `mismem-stats` documents. */
export function statsSummary(db: DB, scopePrefix?: string): StatsSummary {
  const scopeFilter = scopePrefix ? `WHERE scope LIKE ?` : "";
  const scopeParam: unknown[] = scopePrefix ? [`${scopePrefix}%`] : [];

  const epTotal = db.prepare(`SELECT COUNT(*) AS n FROM episodes ${scopeFilter}`).get(...scopeParam) as { n: number };
  const epUnc = db
    .prepare(`SELECT COUNT(*) AS n FROM episodes WHERE consolidated_into IS NULL ${scopePrefix ? "AND scope LIKE ?" : ""}`)
    .get(...scopeParam) as { n: number };
  const memTotal = db.prepare(`SELECT COUNT(*) AS n FROM memories ${scopeFilter}`).get(...scopeParam) as { n: number };
  const trTotal = db.prepare(`SELECT COUNT(*) AS n FROM traits ${scopeFilter}`).get(...scopeParam) as { n: number };
  const scopes = db
    .prepare(`SELECT scope, COUNT(*) AS count FROM episodes ${scopeFilter} GROUP BY scope ORDER BY count DESC LIMIT 20`)
    .all(...scopeParam) as { scope: string; count: number }[];
  const range = db
    .prepare(`SELECT MIN(created_at) AS min_ts, MAX(created_at) AS max_ts FROM episodes ${scopeFilter}`)
    .get(...scopeParam) as { min_ts: number | null; max_ts: number | null };

  return {
    episodes_total: epTotal.n,
    episodes_unconsolidated: epUnc.n,
    memories_total: memTotal.n,
    traits_total: trTotal.n,
    scopes,
    oldest_episode_ts: range.min_ts,
    newest_episode_ts: range.max_ts,
  };
}

export interface IngestStats {
  episodes: number;
  memories: number;
  traits: number;
  top_scopes: Array<{ scope: string; n: number }>;
}

export function ingestStats(db: DB): IngestStats {
  const ep = db.prepare("SELECT COUNT(*) AS n FROM episodes").get() as { n: number };
  const me = db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number };
  const tr = db.prepare("SELECT COUNT(*) AS n FROM traits").get() as { n: number };
  const topScopes = db
    .prepare("SELECT scope, COUNT(*) AS n FROM episodes GROUP BY scope ORDER BY n DESC LIMIT 20")
    .all() as Array<{ scope: string; n: number }>;
  return { episodes: ep.n, memories: me.n, traits: tr.n, top_scopes: topScopes };
}
