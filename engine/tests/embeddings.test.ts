import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/store/db.js";
import { capture } from "../src/memory/capture.js";
import { consolidate } from "../src/memory/consolidate.js";
import { recallHybrid } from "../src/recall/recall.js";
import {
  saveMemoryEmbedding,
  semanticSearchMemories,
  embedPendingMemories,
  getEmbeddingIndexStatus,
} from "../src/embeddings/store.js";
import type { EmbedFn } from "../src/embeddings/provider.js";

let db: DB;

/** Deterministic fake embedder: projects keywords onto fixed axes. */
const AXES = ["dinero", "musica", "deploy"];
function fakeVec(text: string): Float32Array {
  const v = new Float32Array(AXES.length);
  const t = text.toLowerCase();
  // Synonyms: an axis fires by word family, like a real embedding.
  if (/dinero|plata|deuda|cashflow|finanzas/.test(t)) v[0] = 1;
  if (/musica|banda|cancion|mezcla/.test(t)) v[1] = 1;
  if (/deploy|docker|servidor|produccion/.test(t)) v[2] = 1;
  return v;
}
const fakeEmbed: EmbedFn = async (texts) => texts.map(fakeVec);
const deadEmbed: EmbedFn = async () => null;

function makeMemory(scope: string, gist: string): string {
  const ep = capture(db, { scope, body: `episodio para ${gist}` });
  const m = consolidate(db, { scope, gist, source_episode_ids: [ep.id] });
  return m.memory_id;
}

beforeEach(() => {
  db = openDb(":memory:");
});

describe("semantic store + search", () => {
  it("encuentra memorias por coseno y respeta el scope", () => {
    const m1 = makeMemory("vida", "problemas de plata y deudas del mes");
    const m2 = makeMemory("estudio", "mezcla de la cancion nueva de la banda");
    saveMemoryEmbedding(db, m1, "fake", fakeVec("plata deudas"));
    saveMemoryEmbedding(db, m2, "fake", fakeVec("cancion banda"));

    const hits = semanticSearchMemories(db, fakeVec("finanzas"), { limit: 5 });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe(m1);
    expect(hits[0]?.score).toBeCloseTo(1.0);

    const scoped = semanticSearchMemories(db, fakeVec("finanzas"), {
      scope: "estudio",
      limit: 5,
    });
    expect(scoped).toHaveLength(0);
  });

  it("borrar la memoria borra su embedding (FK cascade)", () => {
    const m1 = makeMemory("vida", "algo con dinero");
    saveMemoryEmbedding(db, m1, "fake", fakeVec("dinero"));
    db.prepare("DELETE FROM memories WHERE id = ?").run(m1);
    const left = db.prepare("SELECT COUNT(*) AS n FROM memory_embeddings").get() as { n: number };
    expect(left.n).toBe(0);
  });
});

describe("embedPendingMemories", () => {
  it("embebe solo lo que falta (idempotente)", async () => {
    makeMemory("vida", "cashflow del mes");
    makeMemory("estudio", "mezcla nueva");
    const first = await embedPendingMemories(db, { embedFn: fakeEmbed, model: "fake" });
    expect(first.pending).toBe(2);
    expect(first.embedded).toBe(2);

    const second = await embedPendingMemories(db, { embedFn: fakeEmbed, model: "fake" });
    expect(second.pending).toBe(0);
    expect(second.embedded).toBe(0);
  });

  it("corta temprano si el embedder está caído", async () => {
    makeMemory("vida", "una");
    makeMemory("vida", "otra");
    const r = await embedPendingMemories(db, { embedFn: deadEmbed, model: "fake" });
    expect(r.embedded).toBe(0);
    expect(r.failed).toBe(2);
  });

  it("una tanda que falla no deja sin vector a las siguientes", async () => {
    for (const g of ["cashflow uno", "cashflow dos", "cashflow tres"]) makeMemory("vida", g);
    let calls = 0;
    const flaky: EmbedFn = async (texts) => (++calls === 1 ? null : fakeEmbed(texts));

    const r = await embedPendingMemories(db, { embedFn: flaky, model: "fake", batchSize: 1 });

    expect(r).toMatchObject({ pending: 3, embedded: 2, failed: 1 });
  });

  it("con dos tandas seguidas fallidas se rinde: el servidor está caído", async () => {
    for (const g of ["a", "b", "c", "d", "e"]) makeMemory("vida", g);
    let calls = 0;
    const dead: EmbedFn = async () => {
      calls++;
      return null;
    };

    const r = await embedPendingMemories(db, { embedFn: dead, model: "fake", batchSize: 1 });

    expect(calls).toBe(2);
    expect(r).toMatchObject({ embedded: 0, failed: 5 });
  });

  it("al modelo le llega el resumen y los detalles recortados, no un texto sin fin", async () => {
    const ep = capture(db, { scope: "vida", body: "fuente" });
    consolidate(db, {
      scope: "vida",
      gist: "Decisión sobre el cashflow",
      details: "x".repeat(20_000),
      source_episode_ids: [ep.id],
    });
    const seen: string[] = [];
    const spy: EmbedFn = async (texts) => {
      seen.push(...texts);
      return fakeEmbed(texts);
    };

    await embedPendingMemories(db, { embedFn: spy, model: "fake" });

    expect(seen[0]!.startsWith("Decisión sobre el cashflow\n")).toBe(true);
    expect(seen[0]!.length).toBe(4000);
  });

  it("reindexa cuando cambia el modelo aunque las dimensiones coincidan", async () => {
    const memoryId = makeMemory("vida", "cashflow del mes");
    await embedPendingMemories(db, {
      embedFn: fakeEmbed,
      model: "modelo-a",
    });
    const next = await embedPendingMemories(db, {
      embedFn: fakeEmbed,
      model: "modelo-b",
    });
    const stored = db
      .prepare(
        "SELECT model, dims FROM memory_embeddings WHERE memory_id = ?",
      )
      .get(memoryId) as { model: string; dims: number };

    expect(next).toMatchObject({
      pending: 1,
      embedded: 1,
      reembedded: 1,
      failed: 0,
    });
    expect(stored).toEqual({ model: "modelo-b", dims: 3 });
  });

  it("conserva el vector anterior si falla el reindexado", async () => {
    const memoryId = makeMemory("vida", "cashflow del mes");
    await embedPendingMemories(db, {
      embedFn: fakeEmbed,
      model: "modelo-a",
    });
    const failed = await embedPendingMemories(db, {
      embedFn: deadEmbed,
      model: "modelo-b",
    });
    const stored = db
      .prepare(
        "SELECT model FROM memory_embeddings WHERE memory_id = ?",
      )
      .get(memoryId) as { model: string };

    expect(failed).toMatchObject({ pending: 1, embedded: 0, failed: 1 });
    expect(stored.model).toBe("modelo-a");
  });

  it("permite reindexar explícitamente el mismo modelo con --force", async () => {
    makeMemory("vida", "cashflow del mes");
    await embedPendingMemories(db, {
      embedFn: fakeEmbed,
      model: "fake",
    });
    const forced = await embedPendingMemories(db, {
      embedFn: fakeEmbed,
      model: "fake",
      force: true,
    });
    expect(forced).toMatchObject({
      pending: 1,
      embedded: 1,
      reembedded: 1,
    });
  });
});

describe("getEmbeddingIndexStatus", () => {
  it("una base vacía no tiene nada que indexar", () => {
    expect(getEmbeddingIndexStatus(db, "m")).toEqual({
      memories: 0,
      embedded: 0,
      missing: 0,
      compatible: 0,
      stale_model: 0,
      stale_dims: 0,
      active_dims: null,
      models: [],
    });
  });

  it("el ancho que produjo el embedder manda sobre la mayoría de vectores viejos", async () => {
    const a = makeMemory("vida", "uno");
    const b = makeMemory("vida", "dos");
    makeMemory("vida", "tres");
    saveMemoryEmbedding(db, a, "m", Float32Array.from([1, 0, 0]));
    saveMemoryEmbedding(db, b, "m", Float32Array.from([1, 0, 0]));
    // The provider now answers with another width: only the new vector is searchable.
    const fiveDims: EmbedFn = async () => [new Float32Array([1, 0, 0, 0, 0])];

    await embedPendingMemories(db, { embedFn: fiveDims, model: "m" });

    expect(getEmbeddingIndexStatus(db, "m")).toMatchObject({
      embedded: 3,
      compatible: 1,
      stale_model: 0,
      stale_dims: 2,
      active_dims: 5,
    });
    // An explicit width still wins over the recorded one.
    expect(getEmbeddingIndexStatus(db, "m", 3)).toMatchObject({
      compatible: 2,
      stale_model: 0,
      stale_dims: 1,
      active_dims: 3,
    });
  });

  it("sólo cuenta como compatible el modelo activo con sus dimensiones dominantes", () => {
    const a = makeMemory("vida", "uno");
    const b = makeMemory("vida", "dos");
    const c = makeMemory("vida", "tres");
    saveMemoryEmbedding(db, a, "m", Float32Array.from([1, 0, 0]));
    saveMemoryEmbedding(db, b, "m", Float32Array.from([1, 0, 0]));
    saveMemoryEmbedding(db, c, "m", Float32Array.from([1, 0, 0, 0, 0]));

    // Two 3-dimension vectors against one of 5: nothing recorded, so the dominant width is 3.
    expect(getEmbeddingIndexStatus(db, "m")).toMatchObject({
      memories: 3,
      embedded: 3,
      missing: 0,
      compatible: 2,
      stale_model: 0,
      stale_dims: 1,
      active_dims: 3,
    });
  });

  it("con dos vectores del mismo modelo y dimensiones distintas, las esperadas mandan", () => {
    const a = makeMemory("vida", "uno");
    const b = makeMemory("vida", "dos");
    saveMemoryEmbedding(db, a, "m", Float32Array.from([1, 0, 0]));
    saveMemoryEmbedding(db, b, "m", Float32Array.from([1, 0, 0, 0, 0]));

    // With no known width it is a tie, settled deterministically by the smaller one.
    expect(getEmbeddingIndexStatus(db, "m")).toMatchObject({
      compatible: 1,
      stale_model: 0,
      stale_dims: 1,
    });
    // With the active model's width, the 5-dimension vector cannot be searched.
    expect(getEmbeddingIndexStatus(db, "m", 5)).toMatchObject({
      compatible: 1,
      stale_model: 0,
      stale_dims: 1,
    });
  });

  it("separa los vectores de otro modelo de los del modelo activo con otro ancho", () => {
    const a = makeMemory("vida", "uno");
    const b = makeMemory("vida", "dos");
    const c = makeMemory("vida", "tres");
    const d = makeMemory("vida", "cuatro");
    saveMemoryEmbedding(db, a, "m", Float32Array.from([1, 0, 0]));
    saveMemoryEmbedding(db, b, "m", Float32Array.from([1, 0, 0]));
    saveMemoryEmbedding(db, c, "m", Float32Array.from([1, 0, 0, 0, 0]));
    saveMemoryEmbedding(db, d, "viejo", Float32Array.from([1, 0, 0]));

    expect(getEmbeddingIndexStatus(db, "m")).toMatchObject({
      memories: 4,
      embedded: 4,
      missing: 0,
      compatible: 2,
      stale_model: 1,
      stale_dims: 1,
    });
  });

  it("un vector de otro modelo es obsoleto y no cambia lo que falta", () => {
    const a = makeMemory("vida", "uno");
    saveMemoryEmbedding(db, a, "viejo", Float32Array.from([1, 0, 0]));

    expect(getEmbeddingIndexStatus(db, "m")).toMatchObject({
      memories: 1,
      embedded: 1,
      missing: 0,
      compatible: 0,
      stale_model: 1,
      stale_dims: 0,
    });
  });

  it("las memorias marcador de ruido no cuentan como sin vector", () => {
    const real = makeMemory("vida", "una memoria de verdad");
    makeMemory("vida", "[noise] lo que el LLM descartó");
    saveMemoryEmbedding(db, real, "m", Float32Array.from([1, 0, 0]));

    expect(getEmbeddingIndexStatus(db, "m")).toMatchObject({
      memories: 1,
      embedded: 1,
      missing: 0,
      stale_model: 0,
      stale_dims: 0,
    });
  });
});

describe("recallHybrid", () => {
  it("suma hits semánticos que el FTS no encuentra (sinónimos)", async () => {
    const m1 = makeMemory("vida", "deudas y cashflow apretado este mes");
    await embedPendingMemories(db, { embedFn: fakeEmbed, model: "fake" });

    // "finanzas" does not appear literally in the gist → FTS5 does not find it...
    const { recall } = await import("../src/recall/recall.js");
    const lexical = recall(db, { query: "finanzas" });
    expect(lexical.hits).toHaveLength(0);

    // ...but the hybrid does, through the embedding.
    const hybrid = await recallHybrid(db, { query: "finanzas" }, fakeEmbed);
    expect(hybrid.hits).toHaveLength(1);
    expect(hybrid.hits[0]?.id).toBe(m1);
    expect(hybrid.hits[0]?.via).toBe("semantic");
  });

  it("no duplica hits que el FTS ya encontró", async () => {
    makeMemory("vida", "deudas del mes");
    await embedPendingMemories(db, { embedFn: fakeEmbed, model: "fake" });
    const hybrid = await recallHybrid(db, { query: "deudas" }, fakeEmbed);
    const ids = hybrid.hits.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("degrada a FTS puro si el embedder está caído", async () => {
    makeMemory("vida", "deploy en docker del servidor");
    const hybrid = await recallHybrid(db, { query: "docker" }, deadEmbed);
    expect(hybrid.hits).toHaveLength(1);
    expect(hybrid.hits[0]?.via).toBeUndefined();
  });

  it("refuerza salience de hits semánticos (Hebb)", async () => {
    const m1 = makeMemory("vida", "cashflow apretado");
    db.prepare("UPDATE memories SET salience = 0.5 WHERE id = ?").run(m1);
    await embedPendingMemories(db, { embedFn: fakeEmbed, model: "fake" });
    await recallHybrid(db, { query: "finanzas" }, fakeEmbed);
    const row = db.prepare("SELECT salience FROM memories WHERE id = ?").get(m1) as {
      salience: number;
    };
    expect(row.salience).toBeCloseTo(0.55);
  });

  it("no mezcla embeddings de otro modelo aunque tengan las mismas dimensiones", async () => {
    makeMemory("vida", "cashflow apretado");
    await embedPendingMemories(db, {
      embedFn: fakeEmbed,
      model: "modelo-a",
    });
    const hybrid = await recallHybrid(
      db,
      { query: "finanzas" },
      fakeEmbed,
      { reinforce: false, embeddingModel: "modelo-b" },
    );
    expect(hybrid.hits).toHaveLength(0);
  });

  it("descarta dimensiones incompatibles sin comparar vectores", async () => {
    makeMemory("vida", "cashflow apretado");
    await embedPendingMemories(db, {
      embedFn: fakeEmbed,
      model: "fake",
    });
    const fiveDims: EmbedFn = async () => [new Float32Array([1, 0, 0, 0, 0])];
    const hybrid = await recallHybrid(
      db,
      { query: "finanzas" },
      fiveDims,
      { reinforce: false, embeddingModel: "fake" },
    );
    expect(hybrid.hits).toHaveLength(0);
  });
});
