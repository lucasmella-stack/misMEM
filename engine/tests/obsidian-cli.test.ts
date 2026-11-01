import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { openDb } from "../src/store/db.js";
import { capture } from "../src/memory/capture.js";
import { consolidate } from "../src/memory/consolidate.js";

const CLI = fileURLToPath(new URL("../src/obsidian-cli.ts", import.meta.url));
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mismem-obsidian-cli-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[], dbPath: string) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    env: { ...process.env, MISMEM_DB: dbPath },
    encoding: "utf8",
  });
}

describe("mismem-obsidian", () => {
  it("falla si la base no existe en vez de crearla, también con --dry-run", () => {
    const dbPath = join(dir, "no-existe.db");
    const vault = join(dir, "vault");
    const result = run(["--out", vault, "--dry-run"], dbPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no existe");
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(vault)).toBe(false);
  });

  it("no toca un SQLite que no es de misMEM", () => {
    const dbPath = join(dir, "otra.db");
    const other = new Database(dbPath);
    other.exec("CREATE TABLE notas (texto TEXT)");
    other.close();
    const result = run(["--out", join(dir, "vault")], dbPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no es una base de misMEM");
    const after = new Database(dbPath, { readonly: true });
    const tables = after.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    const journal = after.pragma("journal_mode", { simple: true });
    after.close();
    expect(tables).toEqual([{ name: "notas" }]);
    expect(journal).toBe("delete");
  });

  it("exporta con una base existente", () => {
    const dbPath = join(dir, "mem.db");
    const db = openDb(dbPath);
    const episode = capture(db, { scope: "a", body: "un episodio" }).id;
    consolidate(db, { scope: "a", gist: "una memoria", source_episode_ids: [episode] });
    db.close();

    const vault = join(dir, "vault");
    const result = run(["--out", vault], dbPath);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ memories: 1, scopes: 1, removed: 0 });
    expect(existsSync(join(vault, "misMEM", ".mismem-export.json"))).toBe(true);
  });

  it("falla con la base vacía en vez de vaciar la bóveda", () => {
    const dbPath = join(dir, "vacia.db");
    openDb(dbPath).close();
    const vault = join(dir, "vault");
    const result = run(["--out", vault], dbPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ERROR: no hay memorias ni rasgos que exportar: no se toca la bóveda");
    expect(existsSync(vault)).toBe(false);
  });
});
