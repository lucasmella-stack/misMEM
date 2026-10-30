import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/db.js";
import { capture, consolidate, recallHybrid } from "../src/tools.js";
import {
  saveMemoryEmbedding,
  semanticSearchMemories,
  embedPendingMemories,
} from "../src/embeddings/store.js";
import type { EmbedFn } from "../src/embeddings/provider.js";

let db: DB;

/** Embedder fake determinístico: proyecta keywords a ejes fijos. */
const AXES = ["dinero", "musica", "deploy"];
function fakeVec(text: string): Float32Array {
  const v = new Float32Array(AXES.length);
  const t = text.toLowerCase();
  // Sinónimos: el eje se activa por familia de palabras, como un embedding real.
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

  it("añade la huella a una base creada antes y la migración se puede repetir", () => {
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
        } finally {
          reopened.close();
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("recallHybrid", () => {
  it("suma hits semánticos que el FTS no encuentra (sinónimos)", async () => {
    const m1 = makeMemory("vida", "deudas y cashflow apretado este mes");
    await embedPendingMemories(db, { embedFn: fakeEmbed, model: "fake" });

    // "finanzas" no aparece literal en el gist → FTS5 no lo encuentra...
    const { recall } = await import("../src/tools.js");
    const lexical = recall(db, { query: "finanzas" });
    expect(lexical.hits).toHaveLength(0);

    // ...pero el híbrido sí, vía embedding.
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
