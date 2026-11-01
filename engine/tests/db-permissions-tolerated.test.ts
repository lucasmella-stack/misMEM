import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const chmodError = vi.hoisted(() => ({ code: "EPERM" }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    chmodSync: () => {
      throw Object.assign(new Error("chmod failed"), { code: chmodError.code });
    },
  };
});

import { openDb } from "../src/store/db.js";

describe("db-permissions-tolerated: openDb when chmod fails", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mismem-tol-"));
    chmodError.code = "EPERM";
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.each(["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "ENOENT"])(
    "tolerates %s and still returns a working handle",
    (code) => {
      chmodError.code = code;
      const db = openDb(join(dir, "mem.db"));
      try {
        expect(db.prepare("SELECT 1 AS one").get()).toEqual({ one: 1 });
      } finally {
        db.close();
      }
    },
  );

  it("rethrows any other error such as EINVAL", () => {
    chmodError.code = "EINVAL";
    expect(() => openDb(join(dir, "mem.db"))).toThrow(/chmod failed/);
  });
});
