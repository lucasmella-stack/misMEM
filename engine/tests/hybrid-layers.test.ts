import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/db.js";
import { capture, consolidate, crystallize, recallHybrid } from "../src/tools.js";
import {
  embedLayerItem,
  embedPendingMemories,
  saveLayerEmbedding,
  semanticSearchLayer,
} from "../src/embeddings/store.js";
import type { EmbedFn } from "../src/embeddings/provider.js";

let db: DB;

beforeEach(() => {
  db = openDb(":memory:");
});

/**
 * Unit vector whose cosine with [1, 0] is exactly `score`, so a fake embedder can place
 * each text at a known distance from the query without arithmetic in every test.
 */
function axis(score: number): Float32Array {
  return Float32Array.from([score, Math.sqrt(1 - score * score)]);
}

/** An embedder that knows a fixed text-to-vector table and defaults to a mid distance. */
function tableEmbed(entries: Record<string, Float32Array>): EmbedFn {
  return async (texts) => texts.map((text) => entries[text] ?? axis(0.5));
}

describe("capas semánticas en el recall", () => {
  it("un episodio pendiente y un rasgo aparecen aunque las memorias llenen el tope", async () => {
    // Five memories that only match by meaning, so FTS finds nothing, the rescue stays off
    // and the memory list fills the cap on its own: the case in issue #154.
    const memories: string[] = [];
    for (let i = 0; i < 5; i++) {
      const source = capture(db, { scope: "dev", body: `nota de cocina ${i}` });
      memories.push(
        consolidate(db, {
          scope: "dev",
          gist: `nota de cocina ${i}`,
          source_episode_ids: [source.id],
        }).memory_id,
      );
    }
    const episode = capture(db, { scope: "dev", body: "rotar la contraseña del proxy" }).id;
    const trait = crystallize(db, {
      scope: "dev",
      name: "Prefiere rotar credenciales",
      evidence_memory_ids: [memories[0]!],
    }).trait_id;

    const query = "¿cómo roto la contraseña del proxy?";
    const entries: Record<string, Float32Array> = {
      [query]: axis(1),
      "rotar la contraseña del proxy": axis(0.97),
      "Prefiere rotar credenciales": axis(1),
    };
    for (let i = 0; i < 5; i++) entries[`nota de cocina ${i}`] = axis(0.8);
    const embed = tableEmbed(entries);
    await embedPendingMemories(db, { embedFn: embed, model: "fake" });

    const { hits } = await recallHybrid(
      db,
      { query, limit: 5 },
      embed,
      { reinforce: false, embeddingModel: "fake" },
    );

    const ids = hits.map((hit) => hit.id);
    expect(ids).toContain(episode);
    expect(ids).toContain(trait);
    expect(hits.map((hit) => hit.layer)).toEqual([
      "trait",
      "episode",
      "memory",
      "memory",
      "memory",
    ]);
    expect(hits.find((hit) => hit.id === trait)?.via).toBe("semantic");
    expect(hits.find((hit) => hit.id === episode)?.via).toBe("semantic");
  });

  it("una pregunta ajena no trae rasgos ni episodios", async () => {
    const source = capture(db, { scope: "dev", body: "deudas del mes" });
    const memory = consolidate(db, {
      scope: "dev",
      gist: "deudas del mes",
      source_episode_ids: [source.id],
    }).memory_id;
    const episode = capture(db, { scope: "dev", body: "desplegar el servidor de casa" }).id;
    const trait = crystallize(db, {
      scope: "dev",
      name: "Prefiere desplegar de noche",
      evidence_memory_ids: [memory],
    }).trait_id;

    const query = "fotosíntesis de las plantas";
    const embed = tableEmbed({
      [query]: axis(0),
      "deudas del mes": axis(1),
      "desplegar el servidor de casa": axis(1),
      "Prefiere desplegar de noche": axis(1),
    });
    await embedPendingMemories(db, { embedFn: embed, model: "fake" });

    const { hits } = await recallHybrid(
      db,
      { query, limit: 5 },
      embed,
      { reinforce: false, embeddingModel: "fake" },
    );

    expect(hits).toEqual([]);
    expect(hits.map((hit) => hit.id)).not.toContain(episode);
    expect(hits.map((hit) => hit.id)).not.toContain(trait);
  });
});

describe("backfill de rasgos y episodios", () => {
  it("embebe las dos capas con el mismo embedFn y es idempotente", async () => {
    const source = capture(db, { scope: "dev", body: "origen" });
    const memory = consolidate(db, {
      scope: "dev",
      gist: "memoria consolidada",
      source_episode_ids: [source.id],
    }).memory_id;
    const pending = capture(db, { scope: "dev", body: "rotar la clave del proxy" }).id;
    const trait = crystallize(db, {
      scope: "dev",
      name: "Prefiere rotar credenciales",
      evidence_memory_ids: [memory],
    }).trait_id;

    const seen: string[] = [];
    const embed: EmbedFn = async (texts) => {
      seen.push(...texts);
      return texts.map(() => axis(1));
    };

    const stats = await embedPendingMemories(db, { embedFn: embed, model: "fake" });

    expect(stats.layers).toEqual({ pending: 2, embedded: 2, failed: 0 });
    expect(seen).toContain("rotar la clave del proxy");
    expect(seen).toContain("Prefiere rotar credenciales");
    const rows = db
      .prepare("SELECT layer, item_id FROM layer_embeddings ORDER BY layer, item_id")
      .all();
    expect(rows).toEqual([
      { layer: "episode", item_id: pending },
      { layer: "trait", item_id: trait },
    ]);

    const again = await embedPendingMemories(db, { embedFn: embed, model: "fake" });
    expect(again.layers).toEqual({ pending: 0, embedded: 0, failed: 0 });
  });

  it("embeber un item recién escrito es opcional y un embedder caído no lanza", async () => {
    const episode = capture(db, { scope: "dev", body: "nota nueva" }).id;

    expect(
      await embedLayerItem(db, "episode", episode, {
        embedFn: async () => null,
        model: "fake",
      }),
    ).toBe(false);

    expect(
      await embedLayerItem(db, "episode", episode, {
        embedFn: async (texts) => texts.map(() => axis(1)),
        model: "fake",
      }),
    ).toBe(true);
    expect(
      db
        .prepare("SELECT model FROM layer_embeddings WHERE layer = 'episode' AND item_id = ?")
        .get(episode),
    ).toEqual({ model: "fake" });
  });
});

describe("vectores de capa y ciclo de vida", () => {
  it("consolidar un episodio retira su vector para que no compita", async () => {
    const episode = capture(db, { scope: "dev", body: "pendiente de consolidar" }).id;
    saveLayerEmbedding(db, "episode", episode, "fake", axis(1));
    expect(
      semanticSearchLayer(db, "episode", axis(1), { limit: 5, model: "fake" }),
    ).toHaveLength(1);

    consolidate(db, {
      scope: "dev",
      gist: "memoria que absorbe el episodio",
      source_episode_ids: [episode],
    });

    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM layer_embeddings WHERE layer = 'episode' AND item_id = ?")
        .get(episode),
    ).toEqual({ n: 0 });
  });

  it("abre una base creada antes de layer_embeddings, conserva sus datos y la usa", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mismem-layers-"));
    const path = join(dir, "mem.db");
    try {
      const before = openDb(path);
      const episode = capture(before, { scope: "dev", body: "episodio heredado" }).id;
      // A DB created before this change has no layer table at all.
      before.exec("DROP TABLE layer_embeddings");
      before.close();

      const reopened = openDb(path);
      try {
        expect(
          reopened
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'layer_embeddings'")
            .get(),
        ).toEqual({ name: "layer_embeddings" });
        expect(reopened.prepare("SELECT body FROM episodes WHERE id = ?").get(episode)).toEqual({
          body: "episodio heredado",
        });

        const stats = await embedPendingMemories(reopened, {
          embedFn: async (texts) => texts.map(() => axis(1)),
          model: "fake",
        });
        expect(stats.layers).toEqual({ pending: 1, embedded: 1, failed: 0 });
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

afterEach(() => {
  db.close();
});
