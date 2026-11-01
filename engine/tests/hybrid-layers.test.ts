import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/store/db.js";
import { capture } from "../src/memory/capture.js";
import { consolidate } from "../src/memory/consolidate.js";
import { crystallize } from "../src/memory/crystallize.js";
import { recallHybrid } from "../src/recall/recall.js";
import {
  embedLayerItem,
  saveLayerEmbedding,
  semanticSearchLayer,
} from "../src/embeddings/layers.js";
import {
  embedPendingMemories,
  getEmbeddingIndexStatus,
} from "../src/embeddings/store.js";
import { runConsolidation } from "../src/consolidation/run.js";
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

  it("una memoria más cercana gana a un rasgo aunque el rasgo fuera antes intocable", async () => {
    const source = capture(db, { scope: "dev", body: "origen de la memoria" });
    const memory = consolidate(db, {
      scope: "dev",
      gist: "memoria concreta",
      source_episode_ids: [source.id],
    }).memory_id;
    const trait = crystallize(db, {
      scope: "dev",
      name: "regla general",
      evidence_memory_ids: [memory],
    }).trait_id;
    const query = "consulta";
    const embed = tableEmbed({
      [query]: axis(1),
      "memoria concreta": axis(0.9),
      "regla general": axis(0.8),
    });
    await embedPendingMemories(db, { embedFn: embed, model: "fake" });

    const { hits } = await recallHybrid(
      db,
      { query, limit: 5 },
      embed,
      { reinforce: false, embeddingModel: "fake" },
    );

    // The old 1.15 trait multiplier put the 0.8 trait over the 0.9 memory.
    expect(hits[0]?.layer).toBe("memory");
    expect(hits[0]?.id).toBe(memory);
    expect(hits.map((hit) => hit.id)).toContain(trait);
  });

  it("deja un solo rasgo, el de mayor coseno, en el resultado", async () => {
    const source = capture(db, { scope: "dev", body: "origen" });
    const memory = consolidate(db, {
      scope: "dev",
      gist: "memoria de apoyo",
      source_episode_ids: [source.id],
    }).memory_id;
    const best = crystallize(db, {
      scope: "dev",
      name: "rasgo cercano",
      evidence_memory_ids: [memory],
    }).trait_id;
    const second = crystallize(db, {
      scope: "dev",
      name: "rasgo lejano",
      evidence_memory_ids: [memory],
    }).trait_id;
    const query = "consulta";
    const embed = tableEmbed({
      [query]: axis(1),
      "memoria de apoyo": axis(0.8),
      "rasgo cercano": axis(0.95),
      "rasgo lejano": axis(0.9),
    });
    await embedPendingMemories(db, { embedFn: embed, model: "fake" });

    const { hits } = await recallHybrid(
      db,
      { query, limit: 5 },
      embed,
      { reinforce: false, embeddingModel: "fake" },
    );

    const traits = hits.filter((hit) => hit.layer === "trait");
    expect(traits).toHaveLength(1);
    expect(traits[0]?.id).toBe(best);
    expect(hits.map((hit) => hit.id)).not.toContain(second);
  });

  it("no deja que un rasgo con coincidencia léxica desplace al de mayor coseno", async () => {
    const source = capture(db, { scope: "dev", body: "origen" });
    const memory = consolidate(db, {
      scope: "dev",
      gist: "memoria de apoyo",
      source_episode_ids: [source.id],
    }).memory_id;
    const closest = crystallize(db, {
      scope: "dev",
      name: "prefiere avisar antes",
      evidence_memory_ids: [memory],
    }).trait_id;
    // Only this one matches the query's word, so the lexical list puts it ahead of the
    // trait that is closer by meaning.
    const lexical = crystallize(db, {
      scope: "dev",
      name: "despliegue por la noche",
      evidence_memory_ids: [memory],
    }).trait_id;

    const query = "despliegue";
    const embed = tableEmbed({
      [query]: axis(1),
      "memoria de apoyo": axis(0.8),
      "despliegue por la noche": axis(0.75),
      "prefiere avisar antes": axis(0.95),
    });
    await embedPendingMemories(db, { embedFn: embed, model: "fake" });

    const { hits } = await recallHybrid(
      db,
      { query, limit: 5 },
      embed,
      { reinforce: false, embeddingModel: "fake" },
    );

    // The quota keeps the trait closest by cosine even though the query only names the
    // other one; the trim after the fusion is what removes it from the result. The trim
    // before the fusion is observed in the next test.
    expect(hits.filter((hit) => hit.layer === "trait").map((hit) => hit.id)).toEqual([closest]);
    expect(hits.map((hit) => hit.id)).not.toContain(lexical);
  });

  it("el recorte previo a la fusión mantiene al recuerdo por delante del episodio léxico", async () => {
    const source = capture(db, { scope: "dev", body: "origen de la memoria" });
    const memory = consolidate(db, {
      scope: "dev",
      gist: "memoria de apoyo",
      source_episode_ids: [source.id],
    }).memory_id;
    crystallize(db, {
      scope: "dev",
      name: "prefiere avisar antes",
      evidence_memory_ids: [memory],
    });
    // Below the allowed trait in cosine, so the quota drops both and only the trim after the
    // fusion would hide them. They still hold a place in the semantic ranking, and that
    // place is what the trim before the fusion takes away.
    crystallize(db, { scope: "dev", name: "rasgo segundo", evidence_memory_ids: [memory] });
    crystallize(db, { scope: "dev", name: "rasgo tercero", evidence_memory_ids: [memory] });

    const newer = capture(db, { scope: "dev", body: "despliegue del proxy" }).id;
    const older = capture(db, { scope: "dev", body: "despliegue nocturno" }).id;
    // Pending episodes are ranked by creation date, so the lexical order is fixed and the
    // older one is the second lexical candidate.
    db.prepare("UPDATE episodes SET created_at = ? WHERE id = ?").run(2, newer);
    db.prepare("UPDATE episodes SET created_at = ? WHERE id = ?").run(1, older);

    const query = "despliegue";
    const embed = tableEmbed({
      [query]: axis(1),
      "memoria de apoyo": axis(0.88),
      "prefiere avisar antes": axis(0.98),
      "rasgo segundo": axis(0.96),
      "rasgo tercero": axis(0.94),
    });
    await embedPendingMemories(db, { embedFn: embed, model: "fake" });

    const { hits } = await recallHybrid(
      db,
      { query, limit: 5 },
      embed,
      { reinforce: false, embeddingModel: "fake" },
    );

    const order = hits.map((hit) => hit.id);
    expect(order).toContain(memory);
    expect(order).toContain(older);
    // Trimmed before the fusion, the memory sits on the episode's RRF slot and its salience
    // breaks the tie in its favour. Without the trim the two dropped traits keep the slots
    // above it, the memory falls to the fourth place and the older episode passes it.
    expect(order.indexOf(memory)).toBeLessThan(order.indexOf(older));
  });

  it("deja dos episodios, los de mayor coseno, en el resultado", async () => {
    const source = capture(db, { scope: "dev", body: "origen" });
    const memory = consolidate(db, {
      scope: "dev",
      gist: "memoria de apoyo",
      source_episode_ids: [source.id],
    }).memory_id;
    const first = capture(db, { scope: "dev", body: "episodio uno" }).id;
    const second = capture(db, { scope: "dev", body: "episodio dos" }).id;
    const third = capture(db, { scope: "dev", body: "episodio tres" }).id;
    const query = "consulta";
    const embed = tableEmbed({
      [query]: axis(1),
      "memoria de apoyo": axis(0.8),
      "episodio uno": axis(0.95),
      "episodio dos": axis(0.9),
      "episodio tres": axis(0.85),
    });
    await embedPendingMemories(db, { embedFn: embed, model: "fake" });

    const { hits } = await recallHybrid(
      db,
      { query, limit: 5 },
      embed,
      { reinforce: false, embeddingModel: "fake" },
    );

    const episodes = hits.filter((hit) => hit.layer === "episode").map((hit) => hit.id);
    expect(episodes).toEqual([first, second]);
    expect(episodes).not.toContain(third);
    expect(hits.map((hit) => hit.id)).toContain(memory);
  });

  it("una ajena con cosenos justo por debajo de cada puerta no entra", async () => {
    const source = capture(db, { scope: "dev", body: "origen" });
    const memory = consolidate(db, {
      scope: "dev",
      gist: "memoria de apoyo",
      source_episode_ids: [source.id],
    }).memory_id;
    crystallize(db, {
      scope: "dev",
      name: "rasgo casi",
      evidence_memory_ids: [memory],
    });
    capture(db, { scope: "dev", body: "episodio casi" });

    const query = "consulta";
    const embed = tableEmbed({
      [query]: axis(1),
      "memoria de apoyo": axis(0.5),
      "rasgo casi": axis(0.7099),
      "episodio casi": axis(0.6599),
    });
    await embedPendingMemories(db, { embedFn: embed, model: "fake" });

    const { hits } = await recallHybrid(
      db,
      { query, limit: 5 },
      embed,
      { reinforce: false, embeddingModel: "fake" },
    );

    // Gates are minScore + margin: trait 0.71, episode 0.66, memory minScore 0.65.
    expect(hits).toEqual([]);
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

    expect(stats.layers).toEqual({ pending: 2, embedded: 2, failed: 0, discarded: 0 });
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
    expect(again.layers).toEqual({ pending: 0, embedded: 0, failed: 0, discarded: 0 });
  });

  it("cuenta como descartado el item que cambió mientras se calculaba su vector", async () => {
    const episode = capture(db, { scope: "dev", body: "episodio que se consolida" }).id;
    // The rows are read before the embedder answers, so consolidating here reproduces the
    // race that makes the layer save refuse the vector: the text it was computed from is no
    // longer a pending episode. The run must report it apart from a dead embedder.
    const embed: EmbedFn = async (texts) => {
      consolidate(db, {
        scope: "dev",
        gist: "absorbe el episodio",
        source_episode_ids: [episode],
      });
      return texts.map(() => axis(1));
    };

    const stats = await embedPendingMemories(db, { embedFn: embed, model: "fake" });

    expect(stats.layers).toEqual({ pending: 1, embedded: 0, failed: 0, discarded: 1 });
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

  it("borrar un episodio pendiente retira su vector por disparador", () => {
    const episode = capture(db, { scope: "dev", body: "episodio que se borra" }).id;
    saveLayerEmbedding(db, "episode", episode, "fake", axis(1));
    expect(
      db
        .prepare("SELECT model FROM layer_embeddings WHERE layer = 'episode' AND item_id = ?")
        .get(episode),
    ).toEqual({ model: "fake" });

    // The trigger is the only thing that removes the vector: nothing in the delete path
    // cleans layer_embeddings, so a missing one would leave a row pointing at gone text.
    db.prepare("DELETE FROM episodes WHERE id = ?").run(episode);

    expect(
      db
        .prepare("SELECT 1 FROM layer_embeddings WHERE layer = 'episode' AND item_id = ?")
        .get(episode),
    ).toBeUndefined();
  });

  it("un embedder inyectado que no responde no retiene la escritura más que el tope", async () => {
    const episode = capture(db, { scope: "dev", body: "nota con embedder colgado" }).id;
    const started = Date.now();

    const saved = await embedLayerItem(db, "episode", episode, {
      embedFn: () => new Promise(() => undefined),
      model: "fake",
      timeoutMs: 20,
    });
    const elapsed = Date.now() - started;

    // Without the cap the race never settles and this await never returns, which is the
    // hang that blocked capture, crystallize and the viewer.
    expect(saved).toBe(false);
    expect(elapsed).toBeLessThan(1_000);
    expect(
      db
        .prepare("SELECT 1 FROM layer_embeddings WHERE layer = 'episode' AND item_id = ?")
        .get(episode),
    ).toBeUndefined();
  });

  it("no deja vector huérfano si el episodio se consolida mientras se embebe", async () => {
    const episode = capture(db, { scope: "dev", body: "episodio en vuelo" }).id;
    let release: (vectors: Float32Array[] | null) => void = () => undefined;
    const waiting = new Promise<Float32Array[] | null>((resolve) => {
      release = resolve;
    });
    const pending = embedLayerItem(db, "episode", episode, {
      embedFn: () => waiting,
      model: "fake",
    });
    consolidate(db, {
      scope: "dev",
      gist: "absorbe el episodio en vuelo",
      source_episode_ids: [episode],
    });
    release([axis(1)]);

    expect(await pending).toBe(false);
    expect(
      db
        .prepare("SELECT 1 FROM layer_embeddings WHERE layer = 'episode' AND item_id = ?")
        .get(episode),
    ).toBeUndefined();
  });

  it("no guarda el vector de un episodio consolidado durante el backfill", async () => {
    const episode = capture(db, { scope: "dev", body: "episodio en vuelo" }).id;
    const embed: EmbedFn = async (texts) => {
      if (texts.includes("episodio en vuelo")) {
        consolidate(db, {
          scope: "dev",
          gist: "absorbe el episodio en vuelo",
          source_episode_ids: [episode],
        });
      }
      return texts.map(() => axis(1));
    };

    await embedPendingMemories(db, { embedFn: embed, model: "fake" });

    expect(
      db
        .prepare("SELECT 1 FROM layer_embeddings WHERE layer = 'episode' AND item_id = ?")
        .get(episode),
    ).toBeUndefined();
  });

  it("no guarda el vector si el nombre del rasgo cambia mientras se embebe", async () => {
    const source = capture(db, { scope: "dev", body: "origen" });
    const memory = consolidate(db, {
      scope: "dev",
      gist: "memoria de apoyo",
      source_episode_ids: [source.id],
    }).memory_id;
    const trait = crystallize(db, {
      scope: "dev",
      name: "nombre viejo",
      evidence_memory_ids: [memory],
    }).trait_id;
    let release: (vectors: Float32Array[] | null) => void = () => undefined;
    const waiting = new Promise<Float32Array[] | null>((resolve) => {
      release = resolve;
    });
    const pending = embedLayerItem(db, "trait", trait, {
      embedFn: () => waiting,
      model: "fake",
    });
    db.prepare("UPDATE traits SET name = ? WHERE id = ?").run("nombre nuevo", trait);
    release([axis(1)]);

    expect(await pending).toBe(false);
    expect(
      db
        .prepare("SELECT 1 FROM layer_embeddings WHERE layer = 'trait' AND item_id = ?")
        .get(trait),
    ).toBeUndefined();
  });

  it("el estado cuenta rasgos y episodios pendientes con y sin vector", () => {
    const source = capture(db, { scope: "dev", body: "origen" });
    const memory = consolidate(db, {
      scope: "dev",
      gist: "memoria de apoyo",
      source_episode_ids: [source.id],
    }).memory_id;
    const embeddedTrait = crystallize(db, {
      scope: "dev",
      name: "rasgo con vector",
      evidence_memory_ids: [memory],
    }).trait_id;
    crystallize(db, {
      scope: "dev",
      name: "rasgo sin vector",
      evidence_memory_ids: [memory],
    });
    const embeddedEpisode = capture(db, { scope: "dev", body: "episodio con vector" }).id;
    capture(db, { scope: "dev", body: "episodio sin vector" });
    saveLayerEmbedding(db, "trait", embeddedTrait, "fake", axis(1));
    saveLayerEmbedding(db, "episode", embeddedEpisode, "fake", axis(1));

    const status = getEmbeddingIndexStatus(db, "fake");

    expect(status.layers.trait).toEqual({
      items: 2,
      embedded: 1,
      missing: 1,
      compatible: 1,
      stale_model: 0,
    });
    expect(status.layers.episode).toEqual({
      items: 2,
      embedded: 1,
      missing: 1,
      compatible: 1,
      stale_model: 0,
    });
  });

  it("abre una base creada antes de layer_embeddings, conserva sus datos y la usa", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mismem-layers-"));
    const path = join(dir, "mem.db");
    try {
      const before = openDb(path);
      const source = capture(before, { scope: "dev", body: "origen heredado" }).id;
      const memory = consolidate(before, {
        scope: "dev",
        gist: "memoria heredada",
        source_episode_ids: [source],
      }).memory_id;
      const trait = crystallize(before, {
        scope: "dev",
        name: "rasgo heredado",
        evidence_memory_ids: [memory],
      }).trait_id;
      const episode = capture(before, { scope: "dev", body: "episodio heredado" }).id;
      // A DB created before this change has neither the table nor the triggers that keep it
      // in step with episodes and traits, so a bare DROP TABLE would leave them behind.
      for (const trigger of [
        "layer_embeddings_episode_ad",
        "layer_embeddings_episode_au",
        "layer_embeddings_trait_ad",
      ]) {
        before.exec(`DROP TRIGGER ${trigger}`);
      }
      before.exec("DROP TABLE layer_embeddings");
      before.close();

      const reopened = openDb(path);
      try {
        expect(
          reopened
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'layer_embeddings'")
            .get(),
        ).toEqual({ name: "layer_embeddings" });
        const triggers = reopened
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'layer_embeddings%' ORDER BY name",
          )
          .all() as Array<{ name: string }>;
        expect(triggers.map((row) => row.name)).toEqual([
          "layer_embeddings_episode_ad",
          "layer_embeddings_episode_au",
          "layer_embeddings_trait_ad",
        ]);
        expect(reopened.prepare("SELECT body FROM episodes WHERE id = ?").get(episode)).toEqual({
          body: "episodio heredado",
        });

        const stats = await embedPendingMemories(reopened, {
          embedFn: async (texts) => texts.map(() => axis(1)),
          model: "fake",
        });
        expect(stats.layers).toEqual({ pending: 2, embedded: 2, failed: 0, discarded: 0 });

        reopened.prepare("DELETE FROM traits WHERE id = ?").run(trait);
        expect(
          reopened
            .prepare("SELECT 1 FROM layer_embeddings WHERE layer = 'trait' AND item_id = ?")
            .get(trait),
        ).toBeUndefined();

        consolidate(reopened, {
          scope: "dev",
          gist: "absorbe el episodio heredado",
          source_episode_ids: [episode],
        });
        expect(
          reopened
            .prepare("SELECT 1 FROM layer_embeddings WHERE layer = 'episode' AND item_id = ?")
            .get(episode),
        ).toBeUndefined();
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("la consolidación registra los fallos del backfill de rasgos y episodios", async () => {
    const episode = capture(db, { scope: "dev", body: "episodio sin vector" }).id;
    // Old enough for the pending cutoff; the backfill does not look at it.
    db.prepare("UPDATE episodes SET created_at = ? WHERE id = ?").run(1, episode);
    const logs: string[] = [];
    await runConsolidation(db, {
      // No scope is consolidated, so the run spends no LLM call and only backfills.
      scopeFilter: "sin-escuchas",
      llm: { apiKey: "fake", model: "fake" },
      embedFn: async () => null,
      log: (line) => logs.push(line),
    });

    expect(logs).toContainEqual(expect.stringContaining("capas pendientes=1 embebidas=0 fallidas=1"));
  });
});

afterEach(() => {
  db.close();
});
