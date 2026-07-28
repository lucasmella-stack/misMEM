import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/db.js";
import { capture, consolidate, recallHybrid } from "../src/tools.js";
import {
  saveMemoryEmbedding,
  semanticSearchMemories,
  embedPendingMemories,
  type EmbedFn,
} from "../src/embeddings/index.js";

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
    expect(hits[0].id).toBe(m1);
    expect(hits[0].score).toBeCloseTo(1.0);

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
    expect(hybrid.hits[0].id).toBe(m1);
    expect(hybrid.hits[0].via).toBe("semantic");
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
    expect(hybrid.hits[0].via).toBeUndefined();
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
