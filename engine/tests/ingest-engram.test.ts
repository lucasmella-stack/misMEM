import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { openDb } from "../src/store/db.js";
import { migrateEngram, readEngramDb } from "../src/ingest/engram.js";

const ENGINE = fileURLToPath(new URL("..", import.meta.url));
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mismem-engram-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** An Engram database with the three tables the migration reads, and one deleted row. */
function makeEngramDb(file: string): void {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY, type TEXT, title TEXT, content TEXT, tool_name TEXT,
      project TEXT, scope TEXT, topic_key TEXT, created_at TEXT, deleted_at TEXT
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, project TEXT, directory TEXT, started_at TEXT, ended_at TEXT,
      summary TEXT
    );
    CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, content TEXT, project TEXT, created_at TEXT);
  `);
  db.prepare(
    `INSERT INTO observations VALUES (1, 'decision', 'Pick SQLite', 'because it embeds',
     NULL, 'Proj A', 'personal', 'storage', '2026-01-02T03:04:05.000Z', NULL)`,
  ).run();
  db.prepare(
    `INSERT INTO observations VALUES (2, 'note', 'Gone', 'deleted later',
     NULL, 'Proj A', 'personal', NULL, '2026-01-02T03:04:06.000Z', '2026-01-03T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO sessions VALUES ('s1', 'proj', '/home/x/repo', '2026-02-01T10:00:00.000Z',
     NULL, 'summarised the migration')`,
  ).run();
  db.prepare(
    `INSERT INTO sessions VALUES ('s2', 'proj', '/home/x/repo', '2026-02-02T10:00:00.000Z',
     NULL, '   ')`,
  ).run();
  db.prepare(
    `INSERT INTO user_prompts VALUES (1, 'how do I migrate?', NULL, '2026-03-01T09:00:00.000Z')`,
  ).run();
  db.close();
}

describe("readEngramDb", () => {
  it("reads live observations, summarised sessions and every prompt", () => {
    const file = join(dir, "engram.db");
    makeEngramDb(file);

    const source = readEngramDb(file);

    expect(source.observations.map((o) => o.id)).toEqual([1]);
    expect(source.sessions.map((s) => s.id)).toEqual(["s1"]);
    expect(source.prompts.map((p) => p.id)).toEqual([1]);
  });

  it("leaves the source file byte-identical and creates no -wal or -shm", () => {
    const file = join(dir, "engram.db");
    makeEngramDb(file);
    const before = readFileSync(file);

    const source = readEngramDb(file);

    expect(source.observations).toHaveLength(1);
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(existsSync(`${file}-wal`)).toBe(false);
    expect(existsSync(`${file}-shm`)).toBe(false);
  });

  // Reading writes nothing, so an existing file looks the same with or without the flag; the
  // open flags only show up in what SQLite is willing to create. Without `readonly: true` the
  // connection creates this file, so this test is the one that catches the regression.
  it("refuses a missing source instead of creating an empty database there", () => {
    const missing = join(dir, "missing.db");

    expect(() => readEngramDb(missing)).toThrow(/unable to open/i);
    expect(existsSync(missing)).toBe(false);
  });
});

describe("migrateEngram", () => {
  it("maps observations, sessions and prompts to episodes with their scope", () => {
    const file = join(dir, "engram.db");
    makeEngramDb(file);
    const dst = openDb(":memory:");

    expect(migrateEngram(dst, readEngramDb(file), "engram")).toEqual({
      inserted: 3,
      skipped: 0,
    });

    const rows = dst
      .prepare("SELECT scope, body FROM episodes ORDER BY scope")
      .all() as Array<{ scope: string; body: string }>;
    expect(rows.map((r) => r.scope)).toEqual([
      "engram/global/prompts",
      "engram/proj-a",
      "engram/proj/sessions",
    ]);
    expect(rows[0]!.body).toBe("[user_prompt] how do I migrate?");
    expect(rows[1]!.body).toBe("[decision] [storage] Pick SQLite\n\nbecause it embeds");
    expect(rows[2]!.body).toContain("[session_summary] proj @ /home/x/repo");
    expect(rows[2]!.body).toContain("summarised the migration");
    dst.close();
  });

  it("is idempotent: a second run inserts nothing and counts the duplicates", () => {
    const file = join(dir, "engram.db");
    makeEngramDb(file);
    const source = readEngramDb(file);
    const dst = openDb(":memory:");

    migrateEngram(dst, source, "engram");
    expect(migrateEngram(dst, source, "engram")).toEqual({ inserted: 0, skipped: 3 });
    dst.close();
  });
});

describe("mismem-migrate-engram", () => {
  it("prints the same report and writes the target database", () => {
    const source = join(dir, "engram.db");
    makeEngramDb(source);
    const target = join(dir, "mem.db");

    const result = spawnSync(
      "npx",
      ["tsx", join("src", "migrate-engram-cli.ts"), "--source", source],
      {
        cwd: ENGINE,
        env: { ...process.env, MISMEM_DB: target },
        encoding: "utf8",
        timeout: 60_000,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`[migrate] origen: ${source}`);
    expect(result.stdout).toContain(
      "[migrate] observaciones=1 sesiones(con resumen)=1 prompts=1",
    );
    expect(result.stdout).toContain("[migrate] HECHO insertados=3 omitidos(duplicados)=0");

    const dst = new Database(target, { readonly: true });
    expect(dst.prepare("SELECT COUNT(*) AS n FROM episodes").get()).toEqual({ n: 3 });
    dst.close();
  });
});
