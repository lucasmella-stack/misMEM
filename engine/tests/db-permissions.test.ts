import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, openDefaultDb } from "../src/store/db.js";

const mode = (p: string): number => statSync(p).mode & 0o777;
const posix = process.platform !== "win32";

describe.skipIf(!posix)("db-permissions: openDb", () => {
  const dirs: string[] = [];
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), "mismem-perm-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("creates the database file owner-only even with a permissive umask", () => {
    const previous = process.umask(0o022);
    try {
      const path = join(tmp(), "mem.db");
      openDb(path).close();
      expect(mode(path)).toBe(0o600);
    } finally {
      process.umask(previous);
    }
  });

  it("tightens a pre-existing world-readable file and its WAL sidecars", () => {
    const path = join(tmp(), "mem.db");
    const db = openDb(path);
    chmodSync(path, 0o644);
    for (const s of ["-wal", "-shm"]) if (existsSync(path + s)) chmodSync(path + s, 0o644);
    db.close();
    const reopened = openDb(path);
    try {
      // an open WAL connection keeps the sidecars alive
      expect(mode(path)).toBe(0o600);
      expect(existsSync(`${path}-wal`)).toBe(true);
      expect(mode(`${path}-wal`)).toBe(0o600);
      expect(mode(`${path}-shm`)).toBe(0o600);
    } finally {
      reopened.close();
    }
  });

  it("creates a missing database directory owner-only", () => {
    const previousUmask = process.umask(0o022);
    const previousDb = process.env.MISMEM_DB;
    const dir = join(tmp(), "fresh");
    process.env.MISMEM_DB = join(dir, "mem.db");
    try {
      openDefaultDb().close();
      expect(mode(dir)).toBe(0o700);
    } finally {
      process.umask(previousUmask);
      if (previousDb === undefined) delete process.env.MISMEM_DB;
      else process.env.MISMEM_DB = previousDb;
    }
  });

  it("leaves :memory: alone", () => {
    expect(() => openDb(":memory:").close()).not.toThrow();
  });

  it("does not chmod a directory that already exists", () => {
    const dir = tmp();
    chmodSync(dir, 0o755);
    const previousDb = process.env.MISMEM_DB;
    process.env.MISMEM_DB = join(dir, "mem.db");
    try {
      openDefaultDb().close();
      expect(mode(dir)).toBe(0o755);
    } finally {
      if (previousDb === undefined) delete process.env.MISMEM_DB;
      else process.env.MISMEM_DB = previousDb;
    }
  });
});
