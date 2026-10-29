import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/db.js";
import type { EmbedFn } from "../src/embeddings/provider.js";
import { loadGolden, parseFloor, parseGolden, runGolden } from "../src/golden.js";

const DAY_MS = 86_400_000;
const AT = Date.UTC(2026, 0, 15);
const lexical: EmbedFn = async () => null;

// Minimal inline corpus: covers all four layers, a marker and an off-topic question.
const FILES = [
  {
    name: "dev.jsonl",
    text: [
      JSON.stringify({
        type: "memory",
        key: "dev-01",
        scope: "lucia/dev",
        gist: "El despliegue usa Docker Compose en el servidor de casa",
        days_ago: 12,
        salience: 0.8,
      }),
      JSON.stringify({
        type: "memory",
        key: "dev-02",
        scope: "lucia/dev",
        gist: "La receta del chimichurri lleva perejil y ajo",
        days_ago: 30,
      }),
      JSON.stringify({
        type: "memory",
        key: "dev-03",
        scope: "lucia/dev",
        gist: "[noise] tres episodios sin señal consolidable",
        days_ago: 2,
      }),
      JSON.stringify({
        type: "episode",
        key: "dev-e1",
        scope: "lucia/dev",
        body: "Pendiente: rotar la clave del proxy",
        days_ago: 1,
      }),
      JSON.stringify({
        type: "trait",
        key: "dev-t1",
        scope: "lucia/dev",
        name: "Prefiere desplegar de noche",
        evidence: ["dev-01"],
      }),
      JSON.stringify({ type: "query", id: "dev-q01", kind: "literal", query: "Docker Compose", expect: ["dev-01"] }),
      JSON.stringify({
        type: "query",
        id: "dev-q02",
        kind: "ajena",
        query: "fotosíntesis de las plantas",
        expect: [],
      }),
      JSON.stringify({
        type: "query",
        id: "dev-q03",
        kind: "episodio",
        query: "rotar la clave del proxy",
        expect: ["dev-e1"],
      }),
      JSON.stringify({
        type: "query",
        id: "dev-q04",
        kind: "rasgo",
        query: "desplegar de noche",
        expect: ["dev-t1"],
      }),
      // The marker loads, but recall can never return it: this question always misses and
      // `noiseHits` must stay at 0.
      JSON.stringify({
        type: "query",
        id: "dev-q05",
        kind: "clave",
        query: "episodios sin señal consolidable",
        expect: ["dev-03"],
      }),
    ].join("\n"),
  },
];

let db: DB;

beforeEach(() => {
  db = openDb(":memory:");
});

describe("parseGolden", () => {
  it("agrupa por dominio y valida las referencias entre registros", () => {
    const corpus = parseGolden(FILES);

    expect(Object.keys(corpus.domains)).toEqual(["dev"]);
    expect(corpus.domains.dev).toHaveLength(10);
    expect(corpus.domains.dev?.every((record) => record.domain === "dev")).toBe(true);
  });

  it("rechaza una línea inválida con fichero y número de línea", () => {
    const files = [
      {
        name: "dev.jsonl",
        text: '{"type":"memory","key":"a","scope":"s","gist":"x","days_ago":1}\n{"type":"memory"}',
      },
    ];

    expect(() => parseGolden(files)).toThrow(/dev\.jsonl:2/);
  });

  it("rechaza una expectativa que nombra una clave inexistente", () => {
    const files = [
      {
        name: "dev.jsonl",
        text: JSON.stringify({ type: "query", id: "q1", kind: "literal", query: "x", expect: ["fantasma"] }),
      },
    ];

    expect(() => parseGolden(files)).toThrow(/fantasma/);
  });

  it("rechaza una pregunta ajena que espera algo", () => {
    const files = [
      {
        name: "dev.jsonl",
        text: [
          JSON.stringify({ type: "memory", key: "m1", scope: "s", gist: "x", days_ago: 1 }),
          JSON.stringify({ type: "query", id: "q1", kind: "ajena", query: "x", expect: ["m1"] }),
        ].join("\n"),
      },
    ];

    expect(() => parseGolden(files)).toThrow(/ajena/);
  });

  it("rechaza una clave repetida entre ficheros", () => {
    const files = [
      { name: "uno.jsonl", text: JSON.stringify({ type: "memory", key: "m1", scope: "s", gist: "x", days_ago: 1 }) },
      { name: "dos.jsonl", text: JSON.stringify({ type: "memory", key: "m1", scope: "s", gist: "y", days_ago: 1 }) },
    ];

    expect(() => parseGolden(files)).toThrow(/dos\.jsonl:1/);
  });
});

describe("loadGolden", () => {
  it("inserta las memorias con su antigüedad, su saliencia y un episodio consolidado", () => {
    const corpus = parseGolden(FILES);
    const ids = loadGolden(db, corpus, AT);
    const memoryId = ids.get("dev-01");
    const episodeId = ids.get("dev-e1");
    if (!memoryId || !episodeId) throw new Error("faltan ids en el mapa");

    const memory = db
      .prepare("SELECT salience, created_at, salience_updated_at, source_episode_ids FROM memories WHERE id = ?")
      .get(memoryId) as { salience: number; created_at: number; salience_updated_at: number; source_episode_ids: string };
    expect(memory.salience).toBe(0.8);
    expect(memory.created_at).toBe(AT - 12 * DAY_MS);
    expect(memory.salience_updated_at).toBe(memory.created_at);

    const source = db
      .prepare("SELECT body, consolidated_into FROM episodes WHERE id = ?")
      .get(JSON.parse(memory.source_episode_ids)[0]) as { body: string; consolidated_into: string };
    expect(source.consolidated_into).toBe(memoryId);
    expect(source.body).toContain("Docker Compose");

    const pending = db
      .prepare("SELECT body, consolidated_into, created_at FROM episodes WHERE id = ?")
      .get(episodeId) as { body: string; consolidated_into: string | null; created_at: number };
    expect(pending.consolidated_into).toBeNull();
    expect(pending.created_at).toBe(AT - DAY_MS);

    const trait = db
      .prepare("SELECT evidence_memory_ids FROM traits WHERE scope = 'lucia/dev'")
      .get() as { evidence_memory_ids: string };
    expect(JSON.parse(trait.evidence_memory_ids)).toEqual([memoryId]);

    // Three memories, three consolidated episodes and the corpus's pending one.
    expect((db.prepare("SELECT COUNT(*) AS n FROM episodes").get() as { n: number }).n).toBe(4);
    expect((db.prepare("SELECT COUNT(*) AS n FROM traits").get() as { n: number }).n).toBe(1);
  });
});

describe("runGolden", () => {
  it("mide aciertos por tipo y dominio, y una ajena no trae nada", async () => {
    const corpus = parseGolden(FILES);
    const ids = loadGolden(db, corpus, AT);
    const report = await runGolden(db, corpus, ids, { limit: 5, embedFn: lexical, at: AT });

    expect(report.kinds.literal).toEqual({
      questions: 1,
      hitAt1: 1,
      hitAt3: 1,
      hitAtLimit: 1,
      mrr: 1,
    });
    expect(report.kinds.episodio?.hitAtLimit).toBe(1);
    expect(report.kinds.rasgo?.hitAtLimit).toBe(1);
    // The marker loaded but never competes: the question cannot hit.
    expect(report.kinds.clave?.hitAtLimit).toBe(0);
    expect(report.noiseHits).toBe(0);

    expect(report.offTopic).toEqual({ withHits: 0, total: 1, hitsSum: 0 });
    expect(report.domains.dev).toEqual({
      questions: 4,
      hitAt1: 3,
      hitAt3: 3,
      hitAtLimit: 3,
      mrr: 0.75,
    });
    expect(report.global).toEqual({
      questions: 4,
      hitAt1: 3,
      hitAt3: 3,
      hitAtLimit: 3,
      mrr: 0.75,
    });
    expect(report.returned).toEqual({ hitsSum: 3, questions: 4 });
  });
});

describe("parseFloor", () => {
  it("lee el suelo por tipo", () => {
    expect(parseFloor('{"limit":5,"lexico":{"literal":{"hits":2}}}')).toEqual({
      limit: 5,
      lexico: { literal: { hits: 2 } },
    });
  });

  it("rechaza un suelo con un tipo desconocido", () => {
    expect(() => parseFloor('{"limit":5,"lexico":{"inventado":{"hits":1}}}')).toThrow();
  });
});

// The data files are written by another task; without them there is nothing to audit.
const goldenDir = fileURLToPath(new URL("../eval/golden/", import.meta.url));
const dataFiles = existsSync(goldenDir)
  ? readdirSync(goldenDir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
  : [];
const hasData = dataFiles.length > 0;

function readGolden(): Array<{ name: string; text: string }> {
  return dataFiles.map((name) => ({ name, text: readFileSync(join(goldenDir, name), "utf8") }));
}

describe("eval/golden real", () => {
  it.skipIf(!hasData)("los ficheros de datos son válidos y completos", () => {
    const corpus = parseGolden(readGolden());
    expect(Object.keys(corpus.domains).sort()).toEqual(dataFiles.map((name) => name.replace(/\.jsonl$/, "")).sort());
  });

  it.skipIf(!hasData)("el modo léxico no baja del suelo por tipo y no devuelve ruido", async () => {
    const floor = parseFloor(readFileSync(join(goldenDir, "floor.json"), "utf8"));
    const corpus = parseGolden(readGolden());
    const ids = loadGolden(db, corpus, AT);
    const report = await runGolden(db, corpus, ids, { limit: floor.limit, embedFn: lexical, at: AT });

    expect(report.noiseHits).toBe(0);
    if (floor.lexico_ajenas_max !== undefined) {
      expect(report.offTopic.withHits).toBeLessThanOrEqual(floor.lexico_ajenas_max);
    }
    for (const [kind, { hits }] of Object.entries(floor.lexico)) {
      expect(report.kinds[kind]?.hitAtLimit ?? 0).toBeGreaterThanOrEqual(hits);
    }
  });
});
