import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseMode, readCorpus } from "../src/eval-mode.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mismem-eval-mode-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const probe = (embed: () => Promise<{ failed: number }>, embedded: number) => ({
  embed,
  embedded: () => embedded,
});

describe("chooseMode", () => {
  it("un modo léxico explícito no consulta al embedder", async () => {
    const chosen = await chooseMode(
      "lexico",
      probe(async () => {
        throw new Error("no debería embeder");
      }, 0),
    );
    expect(chosen).toEqual({ mode: "lexico", embedded: 0, failed: 0 });
  });

  it("auto pasa a semántico cuando todas las memorias quedaron embebidas", async () => {
    const chosen = await chooseMode("auto", probe(async () => ({ failed: 0 }), 432));
    expect(chosen).toEqual({ mode: "semantico", embedded: 432, failed: 0 });
  });

  it("auto se queda en léxico si un lote falló, e informa de los fallos", async () => {
    const chosen = await chooseMode("auto", probe(async () => ({ failed: 32 }), 400));
    expect(chosen).toEqual({ mode: "lexico", embedded: 400, failed: 32 });
  });

  it("auto se queda en léxico si no hay ninguna memoria embebida", async () => {
    const chosen = await chooseMode("auto", probe(async () => ({ failed: 0 }), 0));
    expect(chosen).toEqual({ mode: "lexico", embedded: 0, failed: 0 });
  });

  it("un modo semántico explícito se respeta con el embedder caído", async () => {
    const chosen = await chooseMode("semantico", probe(async () => ({ failed: 432 }), 0));
    expect(chosen).toEqual({ mode: "semantico", embedded: 0, failed: 432 });
  });
});

describe("readCorpus", () => {
  it("falla en castellano si el directorio no existe", () => {
    const missing = join(tempDir(), "no-existe");
    expect(() => readCorpus(missing)).toThrow(`no existe el directorio ${missing}`);
  });

  it("falla en castellano si el directorio no tiene ningún .jsonl", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "notas.txt"), "no es corpus");
    expect(() => readCorpus(dir)).toThrow(`no hay ficheros .jsonl en ${dir}`);
  });

  it("lee sólo los .jsonl, ordenados por nombre", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "b.jsonl"), "b");
    writeFileSync(join(dir, "a.jsonl"), "a");
    writeFileSync(join(dir, "notas.txt"), "no es corpus");
    expect(readCorpus(dir)).toEqual([
      { name: "a.jsonl", text: "a" },
      { name: "b.jsonl", text: "b" },
    ]);
  });
});
