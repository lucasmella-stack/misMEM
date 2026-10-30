import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/db.js";
import { capture, consolidate, crystallize, recall, recallHybrid } from "../src/tools.js";
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
    // FTS5 indexa `gist` y `details`; el rescate tiene que puntuar sobre ese mismo texto o
    // encuentra el candidato por una columna y lo descarta porque en la otra no está.
    const id = memory(
      "oficina",
      "nota corta sobre la oficina",
      "el controlador de la impresora falla y hay que reinstalarlo",
    );
    expect(memoryIds("controladores impresora")).toEqual([id]);
  });

  it("dos formas de la misma palabra no cuentan como dos coincidencias", () => {
    // `decidir` busca por `deci` y `decision` por `decis`, así que un solo token las
    // satisface a las dos. Sin deduplicar por prefijo, el mínimo de dos se cumple con una
    // única palabra y se rescata la memoria que sólo dice `decision`.
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
    // La de tres coincidencias es más larga a propósito: bm25 penaliza longitud y, sin el
    // orden por coincidencias, adelantaría la corta de dos. Así el test mide ese criterio
    // y no el puesto que ya trae FTS5.
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
    // `solar` recorta a `sola`, que es una palabra distinta. Sin la guarda de longitud, el
    // rescate la cuenta como si fuera una flexión y una pregunta de astronomía trae una
    // memoria que habla de "una sola pasada".
    memory("huerto", "panel solar del tejado");
    memory("dev", "una sola pasada por el sistema dejó todo listo");
    expect(memoryIds("sistema solar")).toEqual([]);
  });

  it("una palabra común no rescata si no la acompañan dos raras", () => {
    // Ocho memorias de fondo hacen que "sistema" y "equipo" sean vocabulario común:
    // cada una aparece en cuatro documentos, por encima del umbral de rareza.
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
    // "sistema" y "equipo" coinciden, pero no distinguen: son comunes.
    memory("pc", "el sistema del equipo de riego");
    // Una sola palabra rara tampoco basta.
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
    // Sin memorias, todos los términos salen con frecuencia 0. Descartarlos por eso vaciaba
    // el rescate en la instalación recién nacida, que es justo donde no hay capa semántica.
    const episode = capture(db, { scope: "dev", body: "configurar servidor nginx" }).id;

    const hits = recall(db, { query: "configurando servidores nginx", reinforce: false }).hits;

    expect(hits.map((hit) => hit.id)).toContain(episode);
  });

  it("rescata un rasgo cuando su nombre no está en ninguna memoria", () => {
    // Los rasgos tampoco viven en `memories_fts`: medir ahí su vocabulario no puede decidir
    // si se rescatan.
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
    // Mismo perfil de términos, así que mismo bm25: sólo cambia la saliencia. La vieja
    // tiene la saliencia cruda más alta; la decaída, más baja. Desempatar por la cruda
    // pondría primero la que ya no se usa; el orden actual desempata por la decaída.
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

  it("con vectores, rasgos y episodios pendientes compiten con su propio vector", async () => {
    const indexada = memory("dev", "configurar servidor apache");
    const pendiente = capture(db, { scope: "dev", body: "configurar servidor nginx" }).id;
    const rasgo = crystallize(db, {
      scope: "dev",
      name: "configurar servidor nginx",
      evidence_memory_ids: [indexada],
    }).trait_id;
    // The stored memory points away from the query; the pending episode and the trait,
    // which used to have no vector, point at it.
    const vecs = new Map<string, Float32Array>([
      ["configurando servidores nginx", Float32Array.from([1, 0])],
      ["configurar servidor apache", Float32Array.from([0, 1])],
      ["configurar servidor nginx", Float32Array.from([1, 0])],
    ]);
    const embed: EmbedFn = async (texts) =>
      texts.map((text) => vecs.get(text) ?? Float32Array.from([0, 1]));
    await embedPendingMemories(db, { embedFn: embed, model: "fake" });
    const query = { query: "configurando servidores nginx", limit: 5, reinforce: false };

    // Sin capa semántica el episodio y el rasgo se rescatan; con ella entran por su vector.
    expect(recall(db, query).hits.map((hit) => hit.id)).toContain(pendiente);
    expect(recall(db, query).hits.map((hit) => hit.id)).toContain(rasgo);
    const result = await recallHybrid(db, query, embed, {
      reinforce: false,
      embeddingModel: "fake",
    });
    expect(result.hits.map((hit) => hit.id)).toContain(pendiente);
    expect(result.hits.map((hit) => hit.id)).toContain(rasgo);
    expect(result.hits.find((hit) => hit.id === pendiente)?.via).toBe("semantic");
    expect(result.hits.find((hit) => hit.id === rasgo)?.via).toBe("semantic");
    expect(result.hits.map((hit) => hit.id)).not.toContain(indexada);
  });

  it("un vector de una memoria de ruido no cierra la puerta al rescate", async () => {
    // `semanticSearchMemories` excluye el ruido, así que ese vector no puntúa nada; si la
    // puerta lo cuenta, apaga el rescate sin capa que lo sustituya. Puede pasar en bases
    // que embebieron memorias `[noise]` antes de que el backfill las excluyera.
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
    // Embeddings activos pero backfill pendiente o modelo cambiado: el vector de la consulta
    // no tiene con qué compararse y el recall depende sólo de lo léxico.
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
    // El corte es una puerta para lo rescatado, no un filtro global: un acierto exacto de
    // FTS5 se devuelve aunque su vector quede por debajo del mínimo.
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
