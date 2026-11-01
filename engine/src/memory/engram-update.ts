// The write behind `mem_update`: an id names a memory or a trait, and its text is replaced.
// A miss returns null so the alias can append an episode instead; composing that capture is
// the alias's job, not this module's.
import type { Database as DB } from "better-sqlite3";

type EngramUpdateTarget = "memory" | "trait";

export interface EngramUpdate {
  target: EngramUpdateTarget;
  /** A trait whose text actually changed, so the caller has to embed its new name. */
  renamed: boolean;
}

export function updateEngramTarget(
  db: DB,
  id: string,
  content: string,
  at: number,
): EngramUpdate | null {
  return db.transaction((): EngramUpdate | null => {
    const memory = db.prepare("UPDATE memories SET gist = ? WHERE id = ?").run(content, id);
    if (memory.changes > 0) {
      // The old vector describes another text: without deleting it, semantic search would
      // keep finding the memory by what it used to say. The backfill recomputes it.
      db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(id);
      return { target: "memory", renamed: false };
    }
    const trait = db.prepare("SELECT name FROM traits WHERE id = ?").get(id) as
      | { name: string }
      | undefined;
    if (!trait) return null;
    if (trait.name === content) {
      // The text did not change, so the vector still describes it and is kept. The touch
      // still counts as an update: the viewer orders traits by `updated_at`.
      db.prepare("UPDATE traits SET updated_at = ? WHERE id = ?").run(at, id);
      return { target: "trait", renamed: false };
    }
    // The vector described the old name; it is deleted here, in the same transaction, and
    // the alias embeds the new one through the best-effort write path afterwards.
    db.prepare("UPDATE traits SET name = ?, updated_at = ? WHERE id = ?").run(content, at, id);
    db.prepare("DELETE FROM layer_embeddings WHERE layer = 'trait' AND item_id = ?").run(id);
    return { target: "trait", renamed: true };
  })();
}
