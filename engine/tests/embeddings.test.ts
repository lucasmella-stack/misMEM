import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/store/db.js";
import { capture } from "../src/memory/capture.js";
import { consolidate } from "../src/memory/consolidate.js";
import { crystallize } from "../src/memory/crystallize.js";
import { recallHybrid } from "../src/recall/recall.js";
import { saveMemoryEmbedding, semanticSearchMemories, embedPendingMemories } from "../src/embeddings/store.js";
import { getEmbeddingIndexStatus } from "../src/embeddings/status.js";
import { loadEmbeddingConfig, type EmbedFn } from "../src/embeddings/provider.js";

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
    expect(second.reembedded).toBe(0);
  });

  it("los ids prioritarios entran en el presupuesto antes que el resto", async () => {
    makeMemory("vida", "cashflow uno");
    makeMemory("vida", "cashflow dos");
    const priority = makeMemory("vida", "mezcla nueva");

    const r = await embedPendingMemories(db, {
      embedFn: fakeEmbed,
      model: "fake",
      maxRows: 1,
      priorityIds: [priority],
    });

    expect(r).toMatchObject({ pending: 3, embedded: 1 });
    const embedded = db.prepare("SELECT memory_id FROM memory_embeddings").all() as Array<{
      memory_id: string;
    }>;
    expect(embedded.map((row) => row.memory_id)).toEqual([priority]);
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

  // The batch used to be all-or-nothing. That pinned the healthy neighbour as pending forever,
  // because the pending order is stable across runs and it always met the same poisoned batch.
  it.each([
    { label: "NaN", bad: [Number.NaN, 0, 0] },
    { label: "Infinity", bad: [Number.POSITIVE_INFINITY, 0, 0] },
    { label: "norma cero", bad: [0, 0, 0] },
    { label: "desbordamiento a Float32", bad: [1e39, 0, 0] },
  ])("un vector con $label se pierde solo y su compañero se guarda", async ({ bad }) => {
    makeMemory("vida", "uno");
    makeMemory("vida", "dos");
    const poisoned: EmbedFn = async () => [Float32Array.from([1, 0, 0]), Float32Array.from(bad)];

    const r = await embedPendingMemories(db, { embedFn: poisoned, model: "fake" });

    expect(r).toMatchObject({ pending: 2, embedded: 1, failed: 1 });
    const stored = db.prepare("SELECT COUNT(*) AS n FROM memory_embeddings").get() as { n: number };
    expect(stored.n).toBe(1);
  });

  it("un lote con dimensiones mezcladas no escribe nada y cuenta como fallido", async () => {
    makeMemory("vida", "uno");
    makeMemory("vida", "dos");
    const poisoned: EmbedFn = async () => [
      Float32Array.from([1, 0, 0]),
      Float32Array.from([1, 0]),
    ];

    const r = await embedPendingMemories(db, { embedFn: poisoned, model: "fake" });

    expect(r).toMatchObject({ pending: 2, embedded: 0, failed: 2 });
    const stored = db.prepare("SELECT COUNT(*) AS n FROM memory_embeddings").get() as { n: number };
    expect(stored.n).toBe(0);
  });

  it("un vector inválido no condena a su compañero de lote", async () => {
    for (const gist of ["cashflow uno", "cashflow dos", "veneno", "cashflow cuatro"]) {
      makeMemory("vida", gist);
    }
    const poisoned: EmbedFn = async (texts) =>
      texts.map((text) =>
        text.includes("veneno") ? new Float32Array([Number.NaN, 0, 0]) : fakeVec(text),
      );

    const r = await embedPendingMemories(db, { embedFn: poisoned, model: "fake", batchSize: 2 });

    expect(r).toMatchObject({ pending: 4, embedded: 3, failed: 1 });
    const stored = db.prepare("SELECT COUNT(*) AS n FROM memory_embeddings").get() as { n: number };
    expect(stored.n).toBe(3);
  });

  it("un embedFn que devuelve menos vectores que textos es un lote nulo", async () => {
    makeMemory("vida", "cashflow uno");
    makeMemory("vida", "cashflow dos");
    const short: EmbedFn = async (texts) => texts.slice(0, 1).map(fakeVec);

    const r = await embedPendingMemories(db, { embedFn: short, model: "fake" });

    expect(r).toMatchObject({ pending: 2, embedded: 0, failed: 2 });
    const stored = db.prepare("SELECT COUNT(*) AS n FROM memory_embeddings").get() as { n: number };
    expect(stored.n).toBe(0);
  });

  it("dos lotes de forma imposible seguidos abortan la corrida", async () => {
    for (const gist of ["a", "b", "c", "d"]) makeMemory("vida", gist);
    let calls = 0;
    const short: EmbedFn = async () => {
      calls++;
      return [];
    };

    const r = await embedPendingMemories(db, { embedFn: short, model: "fake", batchSize: 1 });

    expect(calls).toBe(2);
    expect(r).toMatchObject({ embedded: 0, failed: 4 });
  });

  it("una tanda entera de vectores inválidos cuenta como fallida y aborta a la segunda", async () => {
    for (const gist of ["a", "b", "c", "d", "e"]) makeMemory("vida", gist);
    let calls = 0;
    const zero: EmbedFn = async () => {
      calls++;
      return [new Float32Array([0, 0, 0])];
    };

    const r = await embedPendingMemories(db, { embedFn: zero, model: "fake", batchSize: 1 });

    expect(calls).toBe(2);
    expect(r).toMatchObject({ embedded: 0, failed: 5 });
  });

  it("una tanda entera de NaN también cuenta como fallida", async () => {
    for (const gist of ["a", "b", "c"]) makeMemory("vida", gist);
    let calls = 0;
    const poisoned: EmbedFn = async () => {
      calls++;
      return [new Float32Array([Number.NaN, 0, 0])];
    };

    const r = await embedPendingMemories(db, { embedFn: poisoned, model: "fake", batchSize: 1 });

    expect(calls).toBe(2);
    expect(r).toMatchObject({ embedded: 0, failed: 3 });
  });

  it("el recuento de inválidos ignora el ruido, que el backfill nunca reescribe", () => {
    const noiseId = makeMemory("vida", "[noise] episodio descartado");
    saveMemoryEmbedding(db, noiseId, "fake", new Float32Array([0, 0, 0]));
    const memoryId = makeMemory("vida", "cashflow del mes");
    saveMemoryEmbedding(db, memoryId, "fake", new Float32Array([Number.NaN, 0, 0]));

    expect(getEmbeddingIndexStatus(db, "fake").invalid).toBe(1);
  });

  it("el backfill cura una fila inválida que guardó una versión anterior", async () => {
    const memoryId = makeMemory("vida", "cashflow del mes");
    saveMemoryEmbedding(db, memoryId, "fake", new Float32Array([Number.NaN, 0, 0]));
    expect(getEmbeddingIndexStatus(db, "fake").invalid).toBe(1);

    const r = await embedPendingMemories(db, { embedFn: fakeEmbed, model: "fake" });

    expect(r).toMatchObject({ pending: 1, embedded: 1, reembedded: 1, failed: 0 });
    expect(getEmbeddingIndexStatus(db, "fake").invalid).toBe(0);
    const row = db
      .prepare("SELECT vec FROM memory_embeddings WHERE memory_id = ?")
      .get(memoryId) as { vec: Buffer };
    const stored = new Float32Array(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength / 4);
    expect(Array.from(stored).every(Number.isFinite)).toBe(true);
  });

  it("guarda con norma 1 un vector válido que llega sin normalizar", async () => {
    const memoryId = makeMemory("vida", "cashflow del mes");
    const unnormalized: EmbedFn = async () => [new Float32Array([3, 4, 0])];

    await embedPendingMemories(db, { embedFn: unnormalized, model: "fake" });

    const row = db
      .prepare("SELECT vec FROM memory_embeddings WHERE memory_id = ?")
      .get(memoryId) as { vec: Buffer };
    const stored = new Float32Array(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength / 4);
    expect(Math.hypot(...stored)).toBeCloseTo(1);
    expect(Array.from(stored).map((v) => Number(v.toFixed(3)))).toEqual([0.6, 0.8, 0]);
  });

  it("el backfill acotado reparte el tope entre las tres capas y deja el resto pendiente", async () => {
    const memoryId = makeMemory("vida", "cashflow uno");
    makeMemory("vida", "cashflow dos");
    crystallize(db, { scope: "vida", name: "rasgo de dinero uno", evidence_memory_ids: [memoryId] });
    crystallize(db, { scope: "vida", name: "rasgo de dinero dos", evidence_memory_ids: [memoryId] });

    const first = await embedPendingMemories(db, { embedFn: fakeEmbed, model: "fake", maxRows: 3 });
    const second = await embedPendingMemories(db, { embedFn: fakeEmbed, model: "fake", maxRows: 3 });

    expect(first).toMatchObject({ pending: 2, embedded: 2 });
    expect(first.layers).toEqual({ pending: 2, embedded: 1, failed: 0, discarded: 0 });
    expect(second).toMatchObject({ pending: 0, embedded: 0 });
    expect(second.layers).toEqual({ pending: 1, embedded: 1, failed: 0, discarded: 0 });
  });

  it("con un backlog de memorias que llena el tope, los rasgos conservan su reserva", async () => {
    const source = makeMemory("vida", "cashflow fuente");
    for (let i = 0; i < 99; i++) makeMemory("vida", `cashflow pendiente ${i}`);
    for (let i = 0; i < 10; i++) {
      crystallize(db, { scope: "vida", name: `rasgo de dinero ${i}`, evidence_memory_ids: [source] });
    }

    const r = await embedPendingMemories(db, { embedFn: fakeEmbed, model: "fake", maxRows: 64 });

    // The reservation is a quarter of the cap, capped by what the layers actually need:
    // memories keep the other 54 rows, so the run still stops at 64.
    expect(r).toMatchObject({ pending: 100, embedded: 54 });
    expect(r.layers).toEqual({ pending: 10, embedded: 10, failed: 0, discarded: 0 });
    expect(r.embedded + r.layers.embedded).toBe(64);
  });

  it("con rasgos y episodios pendientes, el reparto reservado no deja a ninguna capa sin filas", async () => {
    const source = makeMemory("vida", "cashflow fuente");
    for (let i = 0; i < 100; i++) makeMemory("vida", `cashflow pendiente ${i}`);
    for (let i = 0; i < 100; i++) {
      crystallize(db, { scope: "vida", name: `rasgo de dinero ${i}`, evidence_memory_ids: [source] });
    }
    for (let i = 0; i < 30; i++) capture(db, { scope: "vida", body: `episodio pendiente ${i} con dinero` });

    const r = await embedPendingMemories(db, { embedFn: fakeEmbed, model: "fake", maxRows: 64 });

    // The 16 rows of the reservation split 8 and 8: traits used to take all 16 first and a
    // pending episode never saw a row while there were traits left.
    expect(r.layers).toEqual({ pending: 130, embedded: 16, failed: 0, discarded: 0 });
    const byLayer = db
      .prepare("SELECT layer, COUNT(*) AS n FROM layer_embeddings GROUP BY layer ORDER BY layer")
      .all();
    expect(byLayer).toEqual([
      { layer: "episode", n: 8 },
      { layer: "trait", n: 8 },
    ]);
    expect(r.embedded + r.layers.embedded).toBe(64);
  });

  it("sin rasgos ni episodios pendientes, las memorias gastan el tope entero", async () => {
    for (let i = 0; i < 100; i++) makeMemory("vida", `cashflow pendiente ${i}`);

    const r = await embedPendingMemories(db, { embedFn: fakeEmbed, model: "fake", maxRows: 64 });

    expect(r).toMatchObject({ pending: 100, embedded: 64 });
    expect(r.layers).toEqual({ pending: 0, embedded: 0, failed: 0, discarded: 0 });
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

describe("huella del texto embebido", () => {
  it("reembebe cuando cambia el prefijo de documento", async () => {
    makeMemory("vida", "cashflow del mes");
    await embedPendingMemories(db, { embedFn: fakeEmbed, model: "fake" });
    const saved = process.env.MISMEM_EMBEDDING_DOC_PREFIX;
    process.env.MISMEM_EMBEDDING_DOC_PREFIX = "search_document: ";
    try {
      const again = await embedPendingMemories(db, { embedFn: fakeEmbed, model: "fake" });
      expect(again).toMatchObject({ pending: 1, embedded: 1, reembedded: 1 });
    } finally {
      if (saved === undefined) delete process.env.MISMEM_EMBEDDING_DOC_PREFIX;
      else process.env.MISMEM_EMBEDDING_DOC_PREFIX = saved;
    }
  });

  it("una edición de los detalles deja la fila pendiente", async () => {
    const memoryId = makeMemory("vida", "cashflow del mes");
    await embedPendingMemories(db, { embedFn: fakeEmbed, model: "fake" });

    db.prepare("UPDATE memories SET details = ? WHERE id = ?").run("detalle nuevo", memoryId);
    const again = await embedPendingMemories(db, { embedFn: fakeEmbed, model: "fake" });

    expect(again).toMatchObject({ pending: 1, embedded: 1, reembedded: 1 });
  });

  it("una fila antigua sin huella se reembebe una sola vez", async () => {
    makeMemory("vida", "cashflow del mes");
    await embedPendingMemories(db, { embedFn: fakeEmbed, model: "fake" });
    // Rows written before the column existed carry no fingerprint.
    db.prepare("UPDATE memory_embeddings SET fingerprint = NULL").run();

    const once = await embedPendingMemories(db, { embedFn: fakeEmbed, model: "fake" });
    const twice = await embedPendingMemories(db, { embedFn: fakeEmbed, model: "fake" });

    expect(once).toMatchObject({ pending: 1, embedded: 1, reembedded: 1 });
    expect(twice).toMatchObject({ pending: 0, embedded: 0, reembedded: 0 });
  });

  it("la huella usa la configuración con la que se guardó el vector, no la del entorno", () => {
    const memoryId = makeMemory("vida", "cashflow del mes");
    const cfg = { ...loadEmbeddingConfig(), docPrefix: "doc: ", maxChars: 8 };

    saveMemoryEmbedding(db, memoryId, "fake", fakeVec("cashflow"), undefined, cfg);

    expect(getEmbeddingIndexStatus(db, "fake", cfg).outdated).toBe(0);
    expect(
      getEmbeddingIndexStatus(db, "fake", { ...cfg, docPrefix: "otro: " }).outdated,
    ).toBe(1);
  });

  it("el contador de desactualizados excluye los marcadores de ruido", async () => {
    const noise = makeMemory("vida", "[noise] 3 episodios sin señal");
    makeMemory("vida", "cashflow del mes");
    await embedPendingMemories(db, { embedFn: fakeEmbed, model: "fake" });
    // Legacy base: the marker already had a vector, written before the fingerprint column.
    saveMemoryEmbedding(db, noise, "fake", fakeVec("finanzas"));
    db.prepare("UPDATE memory_embeddings SET fingerprint = NULL").run();

    const status = getEmbeddingIndexStatus(db, "fake");

    expect(status.outdated).toBe(1);
  });

  it("añade la huella a una base creada antes, conserva los vectores y la migración se puede repetir", () => {
    const dir = mkdtempSync(join(tmpdir(), "mismem-fingerprint-"));
    const path = join(dir, "mem.db");
    const columns = (open: DB, table: string): string[] =>
      (open.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
    try {
      const before = openDb(path);
      const source = capture(before, { scope: "vida", body: "episodio heredado" });
      const memoryId = consolidate(before, {
        scope: "vida",
        gist: "cashflow del mes",
        source_episode_ids: [source.id],
      }).memory_id;
      const pending = capture(before, { scope: "vida", body: "episodio todavía pendiente" });
      // The vectors are the data the migration must not cost: recreating a table instead
      // of adding a column would pass the column check below and lose both.
      const vec = Buffer.from(new Float32Array([0.6, 0.8]).buffer);
      before
        .prepare(
          `INSERT INTO memory_embeddings (memory_id, model, dims, vec, created_at, fingerprint)
           VALUES (?, 'fake', 2, ?, 1, 'huella')`,
        )
        .run(memoryId, vec);
      before
        .prepare(
          `INSERT INTO layer_embeddings (layer, item_id, model, dims, vec, created_at, fingerprint)
           VALUES ('episode', ?, 'fake', 2, ?, 1, 'huella')`,
        )
        .run(pending.id, vec);
      before.exec("ALTER TABLE memory_embeddings DROP COLUMN fingerprint");
      before.exec("ALTER TABLE layer_embeddings DROP COLUMN fingerprint");
      before.close();

      for (let run = 0; run < 2; run++) {
        const reopened = openDb(path);
        try {
          expect(columns(reopened, "memory_embeddings")).toContain("fingerprint");
          expect(columns(reopened, "layer_embeddings")).toContain("fingerprint");
          expect(reopened.prepare("SELECT gist FROM memories WHERE id = ?").get(memoryId)).toEqual({
            gist: "cashflow del mes",
          });
          const stored = reopened
            .prepare("SELECT memory_id, vec FROM memory_embeddings")
            .all() as Array<{ memory_id: string; vec: Buffer }>;
          expect(stored.map((row) => row.memory_id)).toEqual([memoryId]);
          expect(stored[0]?.vec.equals(vec)).toBe(true);
          const layer = reopened
            .prepare("SELECT item_id, vec FROM layer_embeddings WHERE layer = 'episode'")
            .all() as Array<{ item_id: string; vec: Buffer }>;
          expect(layer.map((row) => row.item_id)).toEqual([pending.id]);
          expect(layer[0]?.vec.equals(vec)).toBe(true);
        } finally {
          reopened.close();
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
      // The fingerprint catches changed text or prefix; dims catch a new width.
      outdated: 0,
      invalid: 0,
      active_dims: null,
      // Layers share the status: a trait and a pending episode are indexed too.
      layers: {
        trait: { items: 0, embedded: 0, missing: 0, compatible: 0, stale_model: 0, outdated: 0 },
        episode: { items: 0, embedded: 0, missing: 0, compatible: 0, stale_model: 0, outdated: 0 },
      },
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
    expect(getEmbeddingIndexStatus(db, "m", undefined, 3)).toMatchObject({
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
      active_dims: 3,
      compatible: 1,
      stale_model: 0,
      stale_dims: 1,
    });
    // With an expected width of 5 the 3-dimension vector is the one search cannot read.
    expect(getEmbeddingIndexStatus(db, "m", undefined, 5)).toMatchObject({
      active_dims: 5,
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

  it("una consulta con vector inválido degrada a léxico sin lanzar", async () => {
    makeMemory("vida", "cashflow apretado");
    await embedPendingMemories(db, { embedFn: fakeEmbed, model: "fake" });
    // Only the lexical rescue finds it: proof that the semantic layer is off.
    const rescatado = capture(db, { scope: "vida", body: "configurar servidor nginx" }).id;
    const poisonedQuery: EmbedFn = async () => [new Float32Array([Number.NaN, 0, 0])];

    const hybrid = await recallHybrid(db, { query: "configurando servidores nginx" }, poisonedQuery, {
      reinforce: false,
      embeddingModel: "fake",
    });

    expect(hybrid.hits.map((hit) => hit.id)).toContain(rescatado);
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
