// Runs against the real embedding server (pnpm test:integration), not a double: these tests catch what
// a fake cannot, a model that ranks Spanish paraphrases badly or a server that changed its API.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../../src/store/db.js";
import { capture } from "../../src/memory/capture.js";
import { consolidate } from "../../src/memory/consolidate.js";
import { recall, recallHybrid } from "../../src/recall/recall.js";
import { embedPendingMemories } from "../../src/embeddings/store.js";
import { embedTexts, loadEmbeddingConfig } from "../../src/embeddings/provider.js";
import { cosine } from "../../src/embeddings/vector.js";
import { runConsolidation } from "../../src/consolidation/run.js";

const cfg = loadEmbeddingConfig();
let db: DB;

function makeMemory(gist: string): string {
  const ep = capture(db, { scope: "vida", body: `episodio: ${gist}` });
  return consolidate(db, { scope: "vida", gist, source_episode_ids: [ep.id] }).memory_id;
}

function storedModel(memoryId: string): string | undefined {
  const row = db.prepare("SELECT model FROM memory_embeddings WHERE memory_id = ?").get(memoryId);
  return (row as { model: string } | undefined)?.model;
}

beforeAll(async () => {
  const probe = await embedTexts(["ping"], cfg, "query");
  // A server that answers with an invalid vector is as unusable as one that does not answer.
  if (!probe?.[0]) {
    throw new Error(
      `El servidor de embeddings no responde en ${cfg.url} con ${cfg.model}: arrancarlo o fijar MISMEM_EMBEDDING_URL.`,
    );
  }
});

beforeEach(() => {
  db = openDb(":memory:");
});

describe("el servidor de embeddings real", () => {
  it("devuelve un vector finito y no nulo por texto, todos de la misma dimensión", async () => {
    const vecs = await embedTexts(["primera nota", "segunda nota algo más larga"], cfg);

    expect(vecs).toHaveLength(2);
    const [a, b] = vecs!;
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.length).toBeGreaterThan(0);
    expect(b!.length).toBe(a!.length);
    for (const v of vecs!) {
      expect(v!.every(Number.isFinite)).toBe(true);
      expect(v!.some((x) => x !== 0)).toBe(true);
    }
  });

  it("acerca una paráfrasis en castellano más que un texto de otro tema", async () => {
    const [query] = (await embedTexts(["problemas de dinero"], cfg, "query"))!;
    const [debts, music] = (await embedTexts(
      ["Hay que pagar las deudas antes de fin de mes, el cashflow está apretado", "Mezclamos la canción nueva de la banda"],
      cfg,
    ))!;

    expect(cosine(query!, debts!)).toBeGreaterThan(cosine(query!, music!));
  });
});

describe("recall con el modelo real", () => {
  it("encuentra por significado lo que la búsqueda por palabras no ve", async () => {
    const debts = makeMemory("Hay que pagar las deudas antes de fin de mes, el cashflow está apretado");
    makeMemory("Mezclamos la canción nueva de la banda en el estudio");
    makeMemory("Desplegamos el servidor con Docker en producción");
    await embedPendingMemories(db);

    expect(recall(db, { query: "problemas de dinero", reinforce: false }).hits).toHaveLength(0);
    const { hits } = await recallHybrid(db, { query: "problemas de dinero" }, undefined, { reinforce: false });

    expect(hits[0]?.id).toBe(debts);
    expect(hits[0]?.via).toBe("semantic");
  });

  it("con el corte configurado, una consulta de otro tema no trae memorias", async () => {
    makeMemory("Hay que pagar las deudas antes de fin de mes, el cashflow está apretado");
    makeMemory("Desplegamos el servidor con Docker en producción");
    await embedPendingMemories(db);

    const { hits } = await recallHybrid(db, { query: "receta de tortilla de patatas" }, undefined, { reinforce: false });

    expect(hits).toEqual([]);
  });
});

describe("el índice con el modelo real", () => {
  it("indexa cada memoria una vez con la dimensión del modelo", async () => {
    const ids = ["deudas del mes", "mezcla de la banda", "despliegue en docker"].map(makeMemory);

    const first = await embedPendingMemories(db);
    const second = await embedPendingMemories(db);

    expect(first).toMatchObject({ pending: 3, embedded: 3, failed: 0 });
    expect(second).toMatchObject({ pending: 0, embedded: 0 });
    const [probe] = (await embedTexts(["x"], cfg))!;
    const dims = db.prepare("SELECT DISTINCT dims FROM memory_embeddings").all() as { dims: number }[];
    expect(dims).toEqual([{ dims: probe!.length }]);
    for (const id of ids) expect(storedModel(id)).toBe(cfg.model);
  });

  it("consolidar deja con vector a las memorias nuevas", async () => {
    const ids = [1, 2].map((n) => {
      const { id } = capture(db, { scope: "t", body: `decisión ${n} sobre el stack elegido` });
      db.prepare("UPDATE episodes SET created_at = ? WHERE id = ?").run(Date.now() - 48 * 3600 * 1000, id);
      return id;
    });
    const distillFn = async () => [{ gist: "Elegimos el stack del proyecto", evidence_episode_ids: ids }];

    await runConsolidation(db, {
      minEpisodesPerScope: 1,
      paretoPrefilter: false,
      llm: { apiKey: "x", model: "x", baseUrl: "x" },
      distillFn,
      log: () => {},
    });

    const { n } = db.prepare("SELECT COUNT(*) AS n FROM memory_embeddings").get() as { n: number };
    expect(n).toBe(1);
  });
});
