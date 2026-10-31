// What the first step of a forget tells the user it would take with it. The confirmation token
// and the deletion live in `memory/edit.ts`; this only counts.
import type { Database as DB } from "better-sqlite3";

export function forgetImpact(db: DB, layer: "memory" | "trait", id: string): Record<string, number> {
  if (layer === "trait") {
    const { n } = db
      .prepare("SELECT json_array_length(evidence_memory_ids) AS n FROM traits WHERE id = ?")
      .get(id) as { n: number };
    // The memories it cites are not deleted; they are counted so the dialog can say so.
    return { memories_cited: n };
  }
  const count = (sql: string): number => (db.prepare(sql).get(id) as { n: number }).n;
  return {
    episodes: count("SELECT COUNT(*) AS n FROM episodes WHERE consolidated_into = ?"),
    traits_citing: count(
      "SELECT COUNT(DISTINCT t.id) AS n FROM traits t, json_each(t.evidence_memory_ids) j WHERE j.value = ?",
    ),
  };
}
