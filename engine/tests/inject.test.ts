import { describe, it, expect } from "vitest";
import {
  formatInjection,
  parseInjection,
  inExcludedScope,
  parseScopeList,
  selectForInjection,
  worthRecalling,
} from "../src/hooks/inject.js";
import type { RecallHit } from "../src/schema.js";

const hit = (over: Partial<RecallHit> & { id: string }): RecallHit => ({
  layer: "memory",
  scope: "trabajo",
  text: "el deploy usa docker compose",
  created_at: 1,
  ...over,
});

describe("worthRecalling", () => {
  it("una pregunta con sustancia justifica buscar", () => {
    expect(worthRecalling("cómo era el deploy de florfitt?")).toBe(true);
  });

  it("un 'dale' no gasta una llamada", () => {
    for (const trivial of ["dale", "ok", "sí", "y eso?", ""]) {
      expect(worthRecalling(trivial)).toBe(false);
    }
  });

  it("pero una pregunta corta sí busca: el piso es bajo a propósito", () => {
    expect(worthRecalling("deploy florfitt")).toBe(true);
  });
});

describe("inExcludedScope", () => {
  it("un prefijo tapa sus subámbitos", () => {
    expect(inExcludedScope("lucas/profile", ["lucas"])).toBe(true);
    expect(inExcludedScope("lucas", ["lucas"])).toBe(true);
  });

  it("pero no a un ámbito que sólo empieza parecido", () => {
    expect(inExcludedScope("lucas-publico", ["lucas"])).toBe(false);
  });

  it("parseScopeList limpia espacios y vacíos", () => {
    expect(parseScopeList(" lucas , chatgpt ,, ")).toEqual(["lucas", "chatgpt"]);
    expect(parseScopeList(undefined)).toEqual([]);
  });
});

describe("selectForInjection", () => {
  it("deja afuera los episodios: son verbatim y forget los borra", () => {
    const hits = [hit({ id: "e1", layer: "episode" }), hit({ id: "m1" }), hit({ id: "t1", layer: "trait" })];
    expect(selectForInjection(hits).map((h) => h.id)).toEqual(["m1", "t1"]);
  });

  it("un ámbito privado no viaja", () => {
    const hits = [hit({ id: "priv", scope: "lucas/profile" }), hit({ id: "ok" })];
    expect(selectForInjection(hits, { excludeScopes: ["lucas"] }).map((h) => h.id)).toEqual(["ok"]);
  });

  it("lo que el contexto ya tiene no se repite", () => {
    const hits = [hit({ id: "viejo" }), hit({ id: "nuevo" })];
    const chosen = selectForInjection(hits, { alreadyPresent: new Set(["viejo"]) });
    expect(chosen.map((h) => h.id)).toEqual(["nuevo"]);
  });

  it("respeta el tope de cantidad", () => {
    const hits = [hit({ id: "a" }), hit({ id: "b" }), hit({ id: "c" }), hit({ id: "d" })];
    expect(selectForInjection(hits, { maxMemories: 2 })).toHaveLength(2);
  });

  it("respeta el presupuesto de caracteres", () => {
    const hits = [hit({ id: "largo", text: "x".repeat(100) }), hit({ id: "corto", text: "y" })];
    expect(selectForInjection(hits, { maxChars: 50 }).map((h) => h.id)).toEqual(["corto"]);
  });
});

describe("formatInjection", () => {
  it("sin recuerdos no escribe nada", () => {
    expect(formatInjection([])).toBe("");
  });

  it("dice de dónde salen y que no son del usuario", () => {
    const text = formatInjection([hit({ id: "m1", scope: "trabajo" })]);
    expect(text).toContain("[m1] trabajo — el deploy usa docker compose");
    expect(text).toMatch(/no se los atribuyas/);
  });
});

describe("parseInjection", () => {
  it("es lo inverso de formatInjection, incluso con un guión largo en el texto", () => {
    const hits = [
      hit({ id: "m1", scope: "trabajo", text: "el deploy — con traefik — usa docker compose" }),
      hit({ id: "t1", layer: "trait", scope: "lucas/perfil", text: "prefiere pnpm" }),
    ];
    expect(parseInjection(formatInjection(hits))).toEqual([
      { id: "m1", scope: "trabajo", text: "el deploy — con traefik — usa docker compose" },
      { id: "t1", scope: "lucas/perfil", text: "prefiere pnpm" },
    ]);
  });

  it("un texto sin la cabecera no aporta nada", () => {
    expect(parseInjection("- [m1] trabajo — parece una entrada pero no lo es")).toEqual([]);
  });
});
