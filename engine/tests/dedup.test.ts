import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DB } from "better-sqlite3";
import { openDb, contentHash } from "../src/db.js";
import { capture, recall } from "../src/tools.js";

let db: DB;

beforeEach(() => {
  db = openDb(":memory:");
});

describe("capture dedup", () => {
  it("re-capturar el mismo (scope, body) devuelve el id original", () => {
    const a = capture(db, { scope: "test", body: "hola mundo" });
    const b = capture(db, { scope: "test", body: "hola mundo" });
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(true);
    expect(b.id).toBe(a.id);
    const count = db.prepare("SELECT COUNT(*) AS n FROM episodes").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("el mismo body en scopes distintos NO deduplica", () => {
    const a = capture(db, { scope: "proyecto-a", body: "misma nota" });
    const b = capture(db, { scope: "proyecto-b", body: "misma nota" });
    expect(b.deduped).toBe(false);
    expect(b.id).not.toBe(a.id);
  });

  it("bodies distintos en el mismo scope NO deduplican", () => {
    const a = capture(db, { scope: "test", body: "nota uno" });
    const b = capture(db, { scope: "test", body: "nota dos" });
    expect(b.deduped).toBe(false);
    expect(b.id).not.toBe(a.id);
  });

  it("el episodio dedupeado sigue siendo recuperable por recall", () => {
    capture(db, { scope: "test", body: "receta de milanesas napolitanas" });
    capture(db, { scope: "test", body: "receta de milanesas napolitanas" });
    const r = recall(db, { query: "milanesas" });
    expect(r.hits).toHaveLength(1);
  });
});

describe("content_hash migration", () => {
  it("backfillea hashes de filas legacy al reabrir la DB", () => {
    const path = join(mkdtempSync(join(tmpdir(), "mismem-test-")), "mem.db");

    // Fila "legacy": insertada sin hash (como las anteriores a v0.2).
    const first = openDb(path);
    first.prepare(
      "INSERT INTO episodes (id, scope, body, created_at) VALUES ('legacy1', 's', 'cuerpo legacy', 1)",
    ).run();
    first.exec("UPDATE episodes SET content_hash = NULL WHERE id = 'legacy1'");
    first.close();

    // Reabrir dispara migrate() → backfill.
    const reopened = openDb(path);
    const row = reopened
      .prepare("SELECT content_hash FROM episodes WHERE id = 'legacy1'")
      .get() as { content_hash: string };
    expect(row.content_hash).toBe(contentHash("cuerpo legacy"));

    // Y capture del mismo body dedupea contra la fila migrada.
    const r = capture(reopened, { scope: "s", body: "cuerpo legacy" });
    expect(r.deduped).toBe(true);
    expect(r.id).toBe("legacy1");
    reopened.close();
  });
});
