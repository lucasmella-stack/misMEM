import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/store/db.js";
import { capture } from "../src/memory/capture.js";
import { consolidate } from "../src/memory/consolidate.js";
import { crystallize } from "../src/memory/crystallize.js";
import { recall, recallHybrid } from "../src/recall/recall.js";
import { embedPendingMemories, saveMemoryEmbedding } from "../src/embeddings/store.js";
import type { EmbedFn } from "../src/embeddings/provider.js";

let db: DB;

function memory(scope: string, gist: string, details?: string): string {
  const e = capture(db, { scope, body: gist });
  return consolidate(db, { scope, gist, details, source_episode_ids: [e.id] }).memory_id;
}

const memoryIds = (query: string): string[] =>
  recall(db, { query, reinforce: false })
    .hits.filter((h) => h.layer === "memory")
    .map((h) => h.id);

beforeEach(() => {
  db = openDb(":memory:");
});

describe("recall léxico: frases normales", () => {
  it("una pregunta con una forma verbal distinta encuentra la memoria", () => {
    const id = memory("pc", "Las luces del teclado del portátil Acer Nitro se controlan con el comando nitro-kb");
    expect(memoryIds("luces teclado")).toEqual([id]);
    expect(memoryIds("cómo controlo las luces del teclado del portátil")).toEqual([id]);
    expect(
      memoryIds(
        "oye, ayer estuve mirando lo del portátil y no me acuerdo de cómo se cambiaban las luces del teclado, me lo recuerdas",
      ),
    ).toEqual([id]);
  });

  it("un plural encuentra el singular", () => {
    const id = memory("finanzas", "la deuda del cashflow quedó saldada en septiembre");
    expect(memoryIds("deudas")).toEqual([id]);
  });

  it("rescata una paráfrasis que vive en los detalles, no sólo en el gist", () => {
    // FTS5 indexes `gist` and `details`; the rescue must score over that same text, or it
    // finds the candidate in one column and discards it because it is missing from the other.
    const id = memory(
      "oficina",
      "nota corta sobre la oficina",
      "el controlador de la impresora falla y hay que reinstalarlo",
    );
    expect(memoryIds("controladores impresora")).toEqual([id]);
  });

  it("dos formas de la misma palabra no cuentan como dos coincidencias", () => {
    // `decidir` searches for `deci` and `decision` for `decis`, so a single token satisfies
    // both. Without prefix dedup, the minimum of two is met by one word and the memory that
    // only says `decision` gets rescued.
    memory("dev", "la decision quedó tomada");
    memory("dev", "vamos a decidir mañana");
    expect(memoryIds("decidir decision")).toEqual([]);
  });

  it("si la búsqueda estricta encuentra algo, el resultado no cambia", () => {
    const exact = memory("dev", "deploy de florfitt con docker compose y traefik");
    memory("dev", "docker en el portátil para pruebas locales");
    expect(memoryIds("florfitt docker")).toEqual([exact]);
  });

  it("al relajar hacen falta dos palabras: una sola en común no alcanza", () => {
    const both = memory("pc", "el teclado retroiluminado tiene luces RGB");
    memory("pc", "el teclado mecánico nuevo");
    expect(memoryIds("cambiar luces del teclado ahora")).toEqual([both]);
  });

  it("al relajar, lo que coincide en más palabras va primero", () => {
    // The three-match one is deliberately longer: bm25 penalises length and, without the
    // order by matches, it would jump ahead of the short two-match one. This way the test
    // measures that criterion and not the rank FTS5 already returns.
    const three = memory(
      "pc",
      "las luces del teclado del portátil y además varias palabras de relleno para alargarla",
    );
    const two = memory("pc", "luces del teclado externo");
    expect(memoryIds("cómo apago las luces del teclado de mi portátil")).toEqual([three, two]);
  });

  it("una pregunta ajena y larga con dos palabras comunes no rescata nada", () => {
    memory("jardin", "el sistema tiene un riego automático para el jardín");
    expect(
      memoryIds("¿cuántos planetas del sistema solar tiene anillos y cuántas lunas rodean a Júpiter?"),
    ).toEqual([]);
  });

  it("un episodio que sólo comparte palabras comunes en las memorias no se rescata", () => {
    for (let i = 0; i < 10; i++) memory("dev", `cambiar la configuracion del proyecto ${i}`);
    for (let i = 0; i < 10; i++) memory("dev", `nota suelta numero ${i}`);
    const episode = capture(db, { scope: "dev", body: "cambiar la configuracion del servidor" }).id;
    const hits = recall(db, { query: "cambiar la configuracion del movil", reinforce: false }).hits;
    expect(hits.map((hit) => hit.id)).not.toContain(episode);
  });

  it("el prefijo no casa con una palabra más corta que la consulta", () => {
    // `solar` wins on the prefix `sola`, a different word. Without the length guard, the
    // rescue counts it as an inflection and an astronomy question brings back a memory
    // that talks about "una sola pasada".
    memory("huerto", "panel solar del tejado");
    memory("dev", "una sola pasada por el sistema dejó todo listo");
    expect(memoryIds("sistema solar")).toEqual([]);
  });

  it("una palabra común no rescata si no la acompañan dos raras", () => {
    // Eight background memories make "sistema" and "equipo" common vocabulary: each
    // appears in four documents, above the rarity threshold.
    for (const gist of [
      "sistema de archivos del servidor",
      "sistema de energía del portátil",
      "sistema de notificaciones del móvil",
      "equipo de fútbol del barrio",
      "equipo de diseño de la oficina",
      "equipo de música del salón",
      "receta de masa madre",
      "el clima de A Coruña",
    ]) {
      memory("pc", gist);
    }
    // "sistema" and "equipo" match but do not discriminate: they are common.
    memory("pc", "el sistema del equipo de riego");
    // A single rare word is not enough either.
    memory("dev", "kubernetes en el cluster");
    const two = memory("dev", "despliegue de kubernetes con traefik en el ingress");

    expect(memoryIds("sistema equipo kubernetes traefik")).toEqual([two]);
  });

  it("el rescate devuelve como mucho tres recuerdos", () => {
    for (const suffix of ["uno", "dos", "tres", "cuatro", "cinco"]) {
      memory("dev", `configurar servidor nginx ${suffix}`);
    }
    expect(memoryIds("configurando servidores nginx")).toHaveLength(3);
  });

  it("con la búsqueda estricta llena, el rescate no añade nada", () => {
    const exact = memory("dev", "deploy de florfitt con docker y traefik");
    memory("dev", "florfitt usa docker a diario");
    expect(memoryIds("florfitt docker traefik")).toEqual([exact]);
  });
});

describe("recall léxico sin memorias: rescata episodios y rasgos", () => {
  it("rescata un episodio cuando sus palabras no están en ninguna memoria", () => {
    // With no memories every term has frequency 0. Discarding them for that emptied the
    // rescue on a fresh install, which is exactly where there is no semantic layer.
    const episode = capture(db, { scope: "dev", body: "configurar servidor nginx" }).id;

    const hits = recall(db, { query: "configurando servidores nginx", reinforce: false }).hits;

    expect(hits.map((hit) => hit.id)).toContain(episode);
  });

  it("rescata un rasgo cuando su nombre no está en ninguna memoria", () => {
    // Traits do not live in `memories_fts` either: measuring their vocabulary there cannot
    // decide whether they are rescued.
    const ajeno = capture(db, { scope: "dev", body: "notas de finanzas" }).id;
    const trait = crystallize(db, {
      scope: "dev",
      name: "configurar servidor nginx",
      evidence_memory_ids: [ajeno],
    }).trait_id;

    const hits = recall(db, { query: "configurando servidores nginx", reinforce: false }).hits;

    expect(hits.map((hit) => hit.id)).toContain(trait);
  });
});

describe("recall estricto: desempates", () => {
  it("con empate de bm25, desempata por la saliencia ya decaída", () => {
    const at = Date.now();
    const stale = memory("pc", "alfa beta gamma delta");
    const fresh = memory("pc", "delta gamma beta alfa");
    // Same term profile, so same bm25: only salience changes. The old one has the higher
    // raw salience; the decayed one is lower. Ties broken by raw salience would put the
    // unused one first; the current order breaks ties by the decayed value.
    db.prepare("UPDATE memories SET salience = 0.9, salience_updated_at = ? WHERE id = ?").run(
      at - 730 * 86_400_000,
      stale,
    );
    db.prepare("UPDATE memories SET salience = 0.2, salience_updated_at = ? WHERE id = ?").run(
      at - 86_400_000,
      fresh,
    );

    const hits = recall(db, { query: "alfa beta gamma delta", limit: 10 }, { reinforce: false, at });

    expect(hits.hits.filter((hit) => hit.layer === "memory").map((hit) => hit.id)).toEqual([
      fresh,
      stale,
    ]);
  });
});

describe("recall híbrido: el rescate sólo cuando no hay capa semántica", () => {
  it("con vectores, lo que sólo llegaría por el rescate no entra", async () => {
    const lexico = memory("dev", "configurar servidor");
    const semantico = memory("finanzas", "temas de finanzas");
    const vecs = new Map<string, Float32Array>([
      ["configurando servidores", Float32Array.from([1, 0])],
      ["configurar servidor", Float32Array.from([0, 1])],
      ["temas de finanzas", Float32Array.from([1, 0])],
    ]);
    const embed: EmbedFn = async (texts) =>
      texts.map((text) => vecs.get(text) ?? Float32Array.from([0, 1]));
    await embedPendingMemories(db, { embedFn: embed, model: "fake" });

    const result = await recallHybrid(
      db,
      { query: "configurando servidores", limit: 5 },
      embed,
      { reinforce: false, embeddingModel: "fake" },
    );

    expect(result.hits.map((hit) => hit.id)).toEqual([semantico]);
    expect(result.hits.map((hit) => hit.id)).not.toContain(lexico);
  });

  it("con vectores, tampoco rescata rasgos ni episodios, que no tienen corte semántico", async () => {
    const indexada = memory("dev", "configurar servidor apache");
    const pendiente = capture(db, { scope: "dev", body: "configurar servidor nginx" }).id;
    const rasgo = crystallize(db, {
      scope: "dev",
      name: "configurar servidor nginx",
      evidence_memory_ids: [indexada],
    }).trait_id;
    const embed: EmbedFn = async (texts) => texts.map(() => Float32Array.from([0, 1]));
    await embedPendingMemories(db, { embedFn: embed, model: "fake" });
    const query = { query: "configurando servidores nginx", limit: 5, reinforce: false };

    // Without a semantic layer the episode and the trait are rescued; with it, the search
    // stays strict.
    expect(recall(db, query).hits.map((hit) => hit.id)).toContain(pendiente);
    expect(recall(db, query).hits.map((hit) => hit.id)).toContain(rasgo);
    const result = await recallHybrid(db, query, async (texts) => texts.map(() => Float32Array.from([1, 0])), {
      reinforce: false,
      embeddingModel: "fake",
    });
    expect(result.hits.map((hit) => hit.id)).not.toContain(pendiente);
    expect(result.hits.map((hit) => hit.id)).not.toContain(rasgo);
    expect(result.hits.map((hit) => hit.id)).not.toContain(indexada);
  });

  it("un vector de una memoria de ruido no cierra la puerta al rescate", async () => {
    // `semanticSearchMemories` excludes noise, so that vector scores nothing; if the gate
    // counted it, it would switch off the rescue with no layer to replace it. This can
    // happen in dbs that embedded `[noise]` memories before the backfill excluded them.
    memory("dev", "configurar servidor apache");
    const ruido = memory("dev", "[noise] 3 episodios sin señal consolidable");
    saveMemoryEmbedding(db, ruido, "fake", Float32Array.from([1, 0]));
    const episode = capture(db, { scope: "dev", body: "configurar servidor nginx" }).id;
    const embed: EmbedFn = async (texts) => texts.map(() => Float32Array.from([1, 0]));

    const result = await recallHybrid(
      db,
      { query: "configurando servidores nginx", limit: 5 },
      embed,
      { reinforce: false, embeddingModel: "fake" },
    );

    expect(result.hits.map((hit) => hit.id)).toContain(episode);
  });

  it("un vector de otro modelo no cierra la puerta al rescate", async () => {
    const otra = memory("dev", "configurar servidor apache");
    saveMemoryEmbedding(db, otra, "otro-modelo", Float32Array.from([1, 0]));
    const episode = capture(db, { scope: "dev", body: "configurar servidor nginx" }).id;
    const embed: EmbedFn = async (texts) => texts.map(() => Float32Array.from([1, 0]));

    const result = await recallHybrid(
      db,
      { query: "configurando servidores nginx", limit: 5 },
      embed,
      { reinforce: false, embeddingModel: "fake" },
    );

    expect(result.hits.map((hit) => hit.id)).toContain(episode);
  });

  it("un vector de otras dimensiones no cierra la puerta al rescate", async () => {
    const otra = memory("dev", "configurar servidor apache");
    saveMemoryEmbedding(db, otra, "fake", Float32Array.from([1, 0, 0]));
    const episode = capture(db, { scope: "dev", body: "configurar servidor nginx" }).id;
    const embed: EmbedFn = async (texts) => texts.map(() => Float32Array.from([1, 0]));

    const result = await recallHybrid(
      db,
      { query: "configurando servidores nginx", limit: 5 },
      embed,
      { reinforce: false, embeddingModel: "fake" },
    );

    expect(result.hits.map((hit) => hit.id)).toContain(episode);
  });

  it("un vector de otro ámbito no cierra la puerta al rescate", async () => {
    const otra = memory("finanzas", "configurar servidor apache");
    saveMemoryEmbedding(db, otra, "fake", Float32Array.from([1, 0]));
    const episode = capture(db, { scope: "dev", body: "configurar servidor nginx" }).id;
    const embed: EmbedFn = async (texts) => texts.map(() => Float32Array.from([1, 0]));

    const result = await recallHybrid(
      db,
      { query: "configurando servidores nginx", scope: "dev", limit: 5 },
      embed,
      { reinforce: false, embeddingModel: "fake" },
    );

    expect(result.hits.map((hit) => hit.id)).toContain(episode);
  });

  it("con el embedder sin responder, rescata como el recall léxico", async () => {
    const id = memory("dev", "configurar servidor nginx");
    const caido: EmbedFn = async () => null;

    const result = await recallHybrid(db, { query: "configurando servidores nginx", limit: 5 }, caido, {
      reinforce: false,
    });

    expect(result.hits.map((hit) => hit.id)).toEqual([id]);
  });

  it("sin ningún vector del modelo activo, rescata", async () => {
    // Embeddings on but backfill pending or model changed: the query vector has nothing
    // to compare against and recall depends on the lexical side alone.
    const id = memory("dev", "configurar servidor nginx");
    const embed: EmbedFn = async (texts) => texts.map(() => Float32Array.from([1, 0]));

    const result = await recallHybrid(
      db,
      { query: "configurando servidores nginx", limit: 5 },
      embed,
      { reinforce: false, embeddingModel: "fake" },
    );

    expect(result.hits.map((hit) => hit.id)).toEqual([id]);
  });

  it("el corte semántico no toca lo que encontró la búsqueda estricta", async () => {
    // The cut is a gate for rescued hits, not a global filter: an exact FTS5 match is
    // returned even if its vector falls below the minimum.
    const id = memory("dev", "deploy docker traefik");
    const vecs = new Map<string, Float32Array>([
      ["docker traefik deploy", Float32Array.from([1, 0])],
      ["deploy docker traefik", Float32Array.from([0, 1])],
    ]);
    const embed: EmbedFn = async (texts) =>
      texts.map((text) => vecs.get(text) ?? Float32Array.from([0, 1]));
    await embedPendingMemories(db, { embedFn: embed, model: "fake" });

    const result = await recallHybrid(
      db,
      { query: "docker traefik deploy", limit: 5 },
      embed,
      { reinforce: false, embeddingModel: "fake" },
    );

    expect(result.hits.map((hit) => hit.id)).toEqual([id]);
  });
});
