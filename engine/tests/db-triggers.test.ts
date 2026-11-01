import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/store/db.js";
import { capture } from "../src/memory/capture.js";
import { consolidate } from "../src/memory/consolidate.js";
import { crystallize } from "../src/memory/crystallize.js";

const triggerSql = (db: ReturnType<typeof openDb>, name: string): string[] =>
  (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").all(name) as Array<{ sql: string }>).map(
    (r) => r.sql,
  );

describe("memories_au and traits_au", () => {
  it("exist exactly once and only fire on the columns that feed the FTS index", () => {
    const db = openDb(":memory:");
    expect(triggerSql(db, "memories_au")).toHaveLength(1);
    expect(triggerSql(db, "memories_au")[0]).toMatch(/AFTER UPDATE OF gist, details ON memories/);
    expect(triggerSql(db, "traits_au")).toHaveLength(1);
    expect(triggerSql(db, "traits_au")[0]).toMatch(/AFTER UPDATE OF name ON traits/);
  });

  it("keep the FTS index in step with an edited gist and trait name", () => {
    const db = openDb(":memory:");
    const ep = capture(db, { scope: "a", body: "body" });
    const { memory_id } = consolidate(db, { scope: "a", gist: "alpha", source_episode_ids: [ep.id] });
    const { trait_id } = crystallize(db, { scope: "a", name: "gamma", evidence_memory_ids: [memory_id] });
    db.prepare("UPDATE memories SET gist = 'bravo' WHERE id = ?").run(memory_id);
    db.prepare("UPDATE traits SET name = 'delta' WHERE id = ?").run(trait_id);
    const hits = (table: string, term: string): number =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${table} MATCH ?`).get(term) as { n: number }).n;
    expect(hits("memories_fts", "alpha")).toBe(0);
    expect(hits("memories_fts", "bravo")).toBe(1);
    expect(hits("traits_fts", "gamma")).toBe(0);
    expect(hits("traits_fts", "delta")).toBe(1);
  });

  it("an old database with the legacy triggers is upgraded on open", () => {
    const dir = mkdtempSync(join(tmpdir(), "mismem-trg-"));
    try {
      const path = join(dir, "m.db");
      openDb(path).close();
      const raw = new Database(path);
      raw.exec("DROP TRIGGER memories_au; CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN SELECT 1; END;");
      raw.close();
      const db = openDb(path);
      expect(triggerSql(db, "memories_au")[0]).toMatch(/UPDATE OF gist, details/);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("los vectores de los marcadores de ruido", () => {
  it("se borran al abrir una base que los traía, y el de una memoria de verdad se queda", () => {
    const dir = mkdtempSync(join(tmpdir(), "mismem-vec-"));
    try {
      const path = join(dir, "m.db");
      openDb(path).close();
      const raw = new Database(path);
      const vector = Buffer.from(new Float32Array([1, 0, 0]).buffer);
      const mem = raw.prepare(
        "INSERT INTO memories (id, scope, gist, source_episode_ids, created_at) VALUES (?,?,?,'[]',0)",
      );
      const vec = raw.prepare(
        "INSERT INTO memory_embeddings (memory_id, model, dims, vec, created_at) VALUES (?,'m',3,?,0)",
      );
      for (const [id, gist] of [
        ["util", "Una memoria de verdad"],
        ["ruido", "[noise] 4 episodios sin señal consolidable"],
        ["pareto", "[pareto:l0] 23 episodios filtrados por baja importancia"],
      ]) {
        mem.run(id, "s", gist);
        vec.run(id, vector);
      }
      expect(raw.prepare("SELECT count(*) n FROM memory_embeddings").get()).toEqual({ n: 3 });
      raw.close();

      const db = openDb(path);
      const left = db
        .prepare("SELECT memory_id FROM memory_embeddings ORDER BY memory_id")
        .all() as Array<{ memory_id: string }>;
      expect(left.map((r) => r.memory_id)).toEqual(["util"]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
