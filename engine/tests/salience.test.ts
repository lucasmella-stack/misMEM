import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database as DB } from "better-sqlite3";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { capture, consolidate, forget } from "../src/tools.js";
import {
  decayMemories,
  decayedSalience,
  reinforceMemories,
} from "../src/salience.js";

const DAY = 86_400_000;
let db: DB;
const tempDirs: string[] = [];

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeMemory(gist: string): { episodeId: string; memoryId: string } {
  const episode = capture(db, { scope: "test", body: `source: ${gist}` });
  const memory = consolidate(db, {
    scope: "test",
    gist,
    source_episode_ids: [episode.id],
  });
  return { episodeId: episode.id, memoryId: memory.memory_id };
}

describe("salience decay", () => {
  it("migra bases antiguas con un checkpoint derivado del último acceso", () => {
    const dir = mkdtempSync(join(tmpdir(), "mismem-salience-"));
    tempDirs.push(dir);
    const path = join(dir, "legacy.db");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        gist TEXT NOT NULL,
        details TEXT,
        source_episode_ids TEXT NOT NULL,
        salience REAL NOT NULL DEFAULT 1.0,
        created_at INTEGER NOT NULL,
        last_accessed_at INTEGER
      );
      INSERT INTO memories (
        id, scope, gist, source_episode_ids, salience, created_at,
        last_accessed_at
      ) VALUES ('legacy', 'test', 'old', '[]', 0.8, 100, 200);
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        gist, details, content='memories', content_rowid='rowid'
      );
      INSERT INTO memories_fts(rowid, gist, details)
      SELECT rowid, gist, COALESCE(details, '') FROM memories;
    `);
    legacy.close();

    const migrated = openDb(path);
    const row = migrated
      .prepare(
        "SELECT salience_updated_at FROM memories WHERE id = 'legacy'",
      )
      .get() as { salience_updated_at: number };
    expect(row.salience_updated_at).toBe(200);
    migrated.close();
  });

  it("reduce a la mitad por cada vida media", () => {
    expect(decayedSalience(1, 0, 90 * DAY, 90)).toBeCloseTo(0.5);
    expect(decayedSalience(1, 0, 180 * DAY, 90)).toBeCloseTo(0.25);
  });

  it("usa un checkpoint y no vuelve a decaer el mismo intervalo", () => {
    const { memoryId } = makeMemory("checkpoint");
    db.prepare(
      `UPDATE memories
       SET salience = 1, created_at = 0, salience_updated_at = 0
       WHERE id = ?`,
    ).run(memoryId);

    decayMemories(db, { at: 90 * DAY, halfLifeDays: 90 });
    decayMemories(db, { at: 90 * DAY, halfLifeDays: 90 });
    const first = db
      .prepare("SELECT salience FROM memories WHERE id = ?")
      .get(memoryId) as { salience: number };
    expect(first.salience).toBeCloseTo(0.5);

    decayMemories(db, { at: 180 * DAY, halfLifeDays: 90 });
    const second = db
      .prepare("SELECT salience FROM memories WHERE id = ?")
      .get(memoryId) as { salience: number };
    expect(second.salience).toBeCloseTo(0.25);
  });

  it("aplica decay pendiente antes del refuerzo Hebbiano", () => {
    const { memoryId } = makeMemory("hebb");
    db.prepare(
      `UPDATE memories
       SET salience = 1, created_at = 0, salience_updated_at = 0
       WHERE id = ?`,
    ).run(memoryId);
    reinforceMemories(db, [memoryId], {
      at: 90 * DAY,
      halfLifeDays: 90,
      boost: 0.05,
    });
    const row = db
      .prepare(
        `SELECT salience, last_accessed_at, salience_updated_at
         FROM memories WHERE id = ?`,
      )
      .get(memoryId) as {
      salience: number;
      last_accessed_at: number;
      salience_updated_at: number;
    };
    expect(row.salience).toBeCloseTo(0.55);
    expect(row.last_accessed_at).toBe(90 * DAY);
    expect(row.salience_updated_at).toBe(90 * DAY);
  });
});

describe("forget con decay", () => {
  it("dry-run calcula elegibilidad sin mutar la memoria", () => {
    const { memoryId } = makeMemory("dry run");
    const old = Date.now() - 365 * DAY;
    db.prepare(
      `UPDATE memories
       SET salience = 0.5, created_at = ?, salience_updated_at = ?
       WHERE id = ?`,
    ).run(old, old, memoryId);

    const before = db
      .prepare(
        "SELECT salience, salience_updated_at FROM memories WHERE id = ?",
      )
      .get(memoryId);
    const result = forget(db, {
      dry_run: true,
      memory_grace_days: 30,
      salience_below: 0.1,
    });
    const after = db
      .prepare(
        "SELECT salience, salience_updated_at FROM memories WHERE id = ?",
      )
      .get(memoryId);

    expect(result.memories_to_delete).toBe(1);
    expect(after).toEqual(before);
  });

  it("protege memorias recientes aunque tengan salience baja", () => {
    const { memoryId } = makeMemory("fresh");
    db.prepare("UPDATE memories SET salience = 0.01 WHERE id = ?").run(
      memoryId,
    );
    const result = forget(db, {
      dry_run: true,
      memory_grace_days: 30,
      salience_below: 0.1,
    });
    expect(result.memories_to_delete).toBe(0);
  });

  it("purga la memoria y sus episodios sin resucitarlos", () => {
    const { episodeId, memoryId } = makeMemory("old source");
    const old = Date.now() - 60 * DAY;
    db.prepare(
      `UPDATE memories
       SET salience = 0.01, created_at = ?, salience_updated_at = ?
       WHERE id = ?`,
    ).run(old, old, memoryId);

    const result = forget(db, {
      dry_run: false,
      before_days: 90,
      memory_grace_days: 30,
      salience_below: 0.1,
    });

    expect(result).toMatchObject({
      memories_to_delete: 1,
      episodes_to_delete: 1,
    });
    expect(
      db.prepare("SELECT 1 FROM memories WHERE id = ?").get(memoryId),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT 1 FROM episodes WHERE id = ?").get(episodeId),
    ).toBeUndefined();
  });
});
