import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE = fileURLToPath(new URL("..", import.meta.url));
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mismem-cli-usage-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Runs the real CLI: the contract is its exit and stderr, not what the parser returns. Going
 * through the running node rather than `npx` saves it resolving the binary on every call, which
 * cost more than the run itself.
 */
function run(cli: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", join(ENGINE, "src", cli), ...args], {
    cwd: ENGINE,
    env: { ...process.env, MISMEM_DB: join(dir, "mem.db") },
    encoding: "utf8",
    timeout: 60_000,
  });
}

// Each case spawns a real process, so it is given the same budget its subprocess already gets:
// with the default of 5 s, the case below that spawns twice failed on a loaded machine.
const SPAWNS = 60_000;

describe("exit de uso de los CLIs", () => {
  it("stats con un flag mal escrito sale con 64 y lo nombra", () => {
    const result = run("stats-cli.ts", ["--scop", "x"]);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain("argumento desconocido");
    expect(result.stderr).toContain("--scop");
  }, SPAWNS);

  it("migrate-engram sin --source sale con 64, igual que con --source sin valor", () => {
    const missing = run("migrate-engram-cli.ts", []);
    expect(missing.status).toBe(64);
    expect(missing.stderr).toContain("falta --source");
    const noValue = run("migrate-engram-cli.ts", ["--source"]);
    expect(noValue.status).toBe(64);
    expect(noValue.stderr).toContain("--source necesita un valor");
  }, SPAWNS);
});
