// Scopes with their counts per layer, ordered by name: the left column of the viewer.
import type { Database as DB } from "better-sqlite3";
import { excludeNoiseSql } from "../store/rows.js";

export interface ScopeCounts {
  scope: string;
  episodes_pending: number;
  episodes_consolidated: number;
  memories: number;
  traits: number;
}

export function scopeCounts(db: DB): ScopeCounts[] {
  const scopes = new Map<string, ScopeCounts>();
  const entry = (scope: string): ScopeCounts => {
    let e = scopes.get(scope);
    if (!e) {
      e = { scope, episodes_pending: 0, episodes_consolidated: 0, memories: 0, traits: 0 };
      scopes.set(scope, e);
    }
    return e;
  };
  for (const r of db
    .prepare(
      `SELECT scope, SUM(consolidated_into IS NULL) AS pending, SUM(consolidated_into IS NOT NULL) AS done
       FROM episodes GROUP BY scope`,
    )
    .all() as Array<{ scope: string; pending: number; done: number }>) {
    entry(r.scope).episodes_pending = r.pending;
    entry(r.scope).episodes_consolidated = r.done;
  }
  for (const r of db
    .prepare(`SELECT scope, COUNT(*) AS n FROM memories m WHERE ${excludeNoiseSql("m")} GROUP BY scope`)
    .all() as Array<{ scope: string; n: number }>) {
    entry(r.scope).memories = r.n;
  }
  for (const r of db.prepare("SELECT scope, COUNT(*) AS n FROM traits GROUP BY scope").all() as Array<{
    scope: string;
    n: number;
  }>) {
    entry(r.scope).traits = r.n;
  }
  return [...scopes.values()].sort((a, b) => a.scope.localeCompare(b.scope));
}
