import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/store/db.js";
import { crystallize } from "../src/memory/crystallize.js";

const ENGINE = fileURLToPath(new URL("..", import.meta.url));
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mismem-embed-cli-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

// The case spawns a real process, so it gets the budget that subprocess already has.
const SPAWNS = 60_000;

describe("mismem-embed", () => {
  it("la ayuda nombra el prefijo de documento, que es el único que invalida vectores", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", join(ENGINE, "src", "embed-cli.ts"), "--help"],
      { cwd: ENGINE, encoding: "utf8", timeout: SPAWNS },
    );

    expect(result.stdout).toContain("prefijo de documento");
  });

  it("sale con 1 cuando sólo falla el backfill de rasgos y episodios", () => {
    const dbPath = join(dir, "mem.db");
    const db = openDb(dbPath);
    try {
      // Only a trait awaits a vector, so the memory counters stay at zero and the old
      // exit condition never saw the failure.
      crystallize(db, {
        scope: "dev",
        name: "rasgo sin vector",
        evidence_memory_ids: ["memory-inexistente"],
      });
    } finally {
      db.close();
    }

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", join(ENGINE, "src", "embed-cli.ts")],
      {
        cwd: ENGINE,
        env: {
          ...process.env,
          MISMEM_DB: dbPath,
          MISMEM_EMBEDDINGS: "on",
          // A closed port: the request is refused at once, so every pending item fails.
          MISMEM_EMBEDDING_URL: "http://127.0.0.1:1",
          MISMEM_EMBEDDING_TIMEOUT_MS: "1000",
        },
        encoding: "utf8",
        timeout: SPAWNS,
      },
    );

    expect(result.stdout).toContain("total embebidas=0 fallidas=1");
    expect(result.status).toBe(1);
  }, SPAWNS);
});
