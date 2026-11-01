import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isFresh, serverReady } from "../src/hooks/readiness.js";

let dir: string;
const db = (): string => join(dir, "mem.db");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mismem-readiness-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const withReinforce = async (): Promise<string[]> => ["recall", "reinforce", "capture"];
const sinReinforce = async (): Promise<string[]> => ["recall", "capture"];

describe("serverReady", () => {
  it("un servidor que expone reinforce está listo", async () => {
    expect(await serverReady("http://s", db(), 100, { probe: withReinforce })).toBe(true);
  });

  it("un servidor sin reinforce no está listo: ahí el hook reforzaría sin querer", async () => {
    expect(await serverReady("http://s", db(), 100, { probe: sinReinforce })).toBe(false);
  });

  it("un servidor caído tampoco: no inyectar es más barato que inyectar mal", async () => {
    const roto = async (): Promise<string[]> => {
      throw new Error("ECONNREFUSED");
    };
    expect(await serverReady("http://s", db(), 100, { probe: roto })).toBe(false);
  });

  it("cachea para no preguntar en cada turno", async () => {
    let llamadas = 0;
    const probe = async (): Promise<string[]> => {
      llamadas++;
      return ["reinforce"];
    };
    await serverReady("http://s", db(), 100, { probe });
    await serverReady("http://s", db(), 100, { probe });
    expect(llamadas).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, "hook-readiness.json"), "utf8")).ready).toBe(true);
  });

  it("cambiar de servidor invalida la caché", async () => {
    await serverReady("http://viejo", db(), 100, { probe: withReinforce });
    expect(await serverReady("http://nuevo", db(), 100, { probe: sinReinforce })).toBe(false);
  });
});

describe("isFresh", () => {
  const base = { url: "http://s", checked: 1_000_000 };

  it("el 'sí' dura horas", () => {
    expect(isFresh({ ...base, ready: true }, "http://s", base.checked + 3_600_000)).toBe(true);
    expect(isFresh({ ...base, ready: true }, "http://s", base.checked + 7 * 3_600_000)).toBe(false);
  });

  it("el 'no' dura poco: así el hook se enciende solo al desplegar", () => {
    expect(isFresh({ ...base, ready: false }, "http://s", base.checked + 5 * 60_000)).toBe(true);
    expect(isFresh({ ...base, ready: false }, "http://s", base.checked + 11 * 60_000)).toBe(false);
  });

  it("sin estado previo hay que preguntar", () => {
    expect(isFresh(undefined, "http://s", 1)).toBe(false);
  });
});
