import { beforeEach, describe, expect, it } from "vitest";
import type { Database as DB } from "better-sqlite3";
import type { ServerResponse } from "node:http";
import { openDb } from "../src/store/db.js";
import { capture } from "../src/memory/capture.js";
import { consolidate } from "../src/memory/consolidate.js";
import { recall, recallHybrid } from "../src/recall/recall.js";
import { embedPendingMemories } from "../src/embeddings/store.js";
import type { EmbedFn } from "../src/embeddings/provider.js";
import { dispatchEngramTool } from "../src/mcp/engram-compat.js";
import { handleSearch } from "../src/http/viewer/read.js";

let db: DB;

function fakeVec(text: string): Float32Array {
  const vec = new Float32Array(2);
  if (/deuda|cashflow|finanzas/.test(text.toLowerCase())) vec[0] = 1;
  if (/docker|deploy/.test(text.toLowerCase())) vec[1] = 1;
  return vec;
}

const fakeEmbed: EmbedFn = async (texts) => texts.map(fakeVec);

function makeMemory(gist: string): string {
  const episode = capture(db, { scope: "test", body: `source ${gist}` });
  return consolidate(db, {
    scope: "test",
    gist,
    source_episode_ids: [episode.id],
  }).memory_id;
}

function makeNoiseMarker(gist: string): string {
  const episode = capture(db, { scope: "test", body: `source ${gist}` });
  const { memory_id } = consolidate(db, {
    scope: "test",
    gist,
    source_episode_ids: [episode.id],
  });
  db.prepare("UPDATE memories SET salience = 0.05 WHERE id = ?").run(memory_id);
  return memory_id;
}

function mockResponse(): {
  response: ServerResponse;
  value: { statusCode: number; body: string };
} {
  const value = {
    statusCode: 200,
    body: "",
    setHeader() {},
    end(payload?: string) {
      this.body = payload ?? "";
    },
  };
  return { response: value as unknown as ServerResponse, value };
}

beforeEach(() => {
  db = openDb(":memory:");
});

describe("ranking híbrido", () => {
  it("ejecuta semántica aunque FTS llene el límite", async () => {
    makeMemory("deudas literal uno");
    makeMemory("deudas literal dos");
    makeMemory("cashflow apretado");
    await embedPendingMemories(db, {
      embedFn: fakeEmbed,
      model: "fake",
    });
    let calls = 0;
    const counted: EmbedFn = async (texts) => {
      calls++;
      return fakeEmbed(texts);
    };

    const result = await recallHybrid(
      db,
      { query: "deudas", limit: 2 },
      counted,
      { reinforce: false, embeddingModel: "fake" },
    );

    expect(calls).toBe(1);
    expect(result.hits).toHaveLength(2);
  });

  it("la relevancia manda: un recuerdo poco usado pero más parecido gana a uno muy usado", async () => {
    const vecs: Record<string, number[]> = {
      "pregunta sobre husos horarios": [1, 0],
      "fechas de postgres sin conversión de zona": [1, 0],
      "configuración general del servidor": [0.8, 0.6],
    };
    const embed: EmbedFn = async (texts) =>
      texts.map((t) => Float32Array.from(vecs[t] ?? [0, 1]));
    const relevant = makeMemory("fechas de postgres sin conversión de zona");
    const popular = makeMemory("configuración general del servidor");
    db.prepare("UPDATE memories SET salience = 0.05 WHERE id = ?").run(relevant);
    db.prepare("UPDATE memories SET salience = 1 WHERE id = ?").run(popular);
    await embedPendingMemories(db, { embedFn: embed, model: "fake" });

    const result = await recallHybrid(
      db,
      { query: "pregunta sobre husos horarios", limit: 2 },
      embed,
      { reinforce: false, embeddingModel: "fake" },
    );
    expect(result.hits.map((hit) => hit.id)).toEqual([relevant, popular]);
  });

  it("a igual parecido, desempata la saliencia", async () => {
    const embed: EmbedFn = async (texts) => texts.map(() => Float32Array.from([1, 0]));
    const quiet = makeMemory("deploy con docker compose");
    const used = makeMemory("deploy con docker y traefik");
    db.prepare("UPDATE memories SET salience = 0.2 WHERE id = ?").run(quiet);
    db.prepare("UPDATE memories SET salience = 0.9 WHERE id = ?").run(used);
    await embedPendingMemories(db, { embedFn: embed, model: "fake" });

    const result = await recallHybrid(
      db,
      { query: "zzz sin coincidencias", limit: 2 },
      embed,
      { reinforce: false, embeddingModel: "fake" },
    );
    expect(result.hits.map((hit) => hit.id)).toEqual([used, quiet]);
  });

  it("la búsqueda por palabras ordena por coincidencia, no por saliencia", () => {
    const close = makeMemory("postgres fechas postgres zona postgres");
    const loose = makeMemory(
      "notas largas de una reunión sobre muchos temas distintos y al final postgres",
    );
    db.prepare("UPDATE memories SET salience = 0.1 WHERE id = ?").run(close);
    db.prepare("UPDATE memories SET salience = 1 WHERE id = ?").run(loose);

    const memories = recall(db, { query: "postgres", limit: 10 }, { reinforce: false }).hits.filter(
      (hit) => hit.layer === "memory",
    );
    expect(memories.map((hit) => hit.id)).toEqual([close, loose]);
  });

  it("una pregunta entera encuentra por palabras: las vacías no cuentan", () => {
    const deploy = makeMemory("Decidimos hacer el deploy con docker compose");
    makeMemory("La reunión sobre el presupuesto quedó para marzo");

    const hits = recall(db, { query: "¿Qué decidimos sobre el deploy?", limit: 10 }, { reinforce: false }).hits;

    expect(hits.filter((hit) => hit.layer === "memory").map((hit) => hit.id)).toEqual([deploy]);
  });

  it("las palabras que sí importan siguen siendo todas obligatorias", () => {
    makeMemory("Decidimos hacer el deploy con docker compose");

    const hits = recall(db, { query: "¿Qué decidimos sobre kubernetes?", limit: 10 }, { reinforce: false }).hits;

    expect(hits.filter((hit) => hit.layer === "memory")).toEqual([]);
  });

  it("una pregunta hecha sólo de palabras vacías no rompe ni inventa resultados", () => {
    makeMemory("Decidimos hacer el deploy con docker compose");

    expect(recall(db, { query: "¿y qué más?", limit: 10 }, { reinforce: false }).hits).toEqual([]);
  });

  it("si la consulta es toda de palabras vacías, se busca tal cual vino", () => {
    const quote = makeMemory("ser o no ser, esa es la cuestión");

    const hits = recall(db, { query: "ser o no ser", limit: 10 }, { reinforce: false }).hits;

    expect(hits.filter((hit) => hit.layer === "memory").map((hit) => hit.id)).toEqual([quote]);
  });

  it("un número corto es una palabra que importa", () => {
    makeMemory("El proxy escucha en el puerto 80");
    const other = makeMemory("El proxy escucha en el puerto 8443");

    const hits = recall(db, { query: "¿en qué puerto escucha el proxy, el 8443?", limit: 10 }, { reinforce: false }).hits;
    const short = recall(db, { query: "proxy puerto 80", limit: 10 }, { reinforce: false }).hits;

    expect(hits.filter((hit) => hit.layer === "memory").map((hit) => hit.id)).toEqual([other]);
    expect(short.filter((hit) => hit.layer === "memory")).toHaveLength(1);
  });

  it("al modelo de embeddings le llega la pregunta entera, no sólo las palabras que quedaron", async () => {
    const seen: string[] = [];
    const embed: EmbedFn = async (texts) => {
      seen.push(...texts);
      return texts.map(fakeVec);
    };

    await recallHybrid(db, { query: "¿Qué decidimos sobre el deploy?", limit: 5 }, embed, { reinforce: false });

    expect(seen).toEqual(["¿Qué decidimos sobre el deploy?"]);
  });

  it("un marcador de ruido no vuelve por palabras, y lo real sigue volviendo", () => {
    makeNoiseMarker("[noise] 3 episodios sin señal consolidable (2026-10-09)");
    makeNoiseMarker("[pareto:l0] 23 episodios filtrados por baja importancia");
    makeMemory("los episodios sin señal de este deploy fueron tres");

    const ruido = recall(db, { query: "episodios sin señal" }, { reinforce: false }).hits;
    expect(ruido.filter((h) => h.layer === "memory").map((h) => h.text)).toEqual([
      "los episodios sin señal de este deploy fueron tres",
    ]);

    const filtrados = recall(db, { query: "filtrados por baja importancia" }, { reinforce: false }).hits;
    expect(filtrados.filter((h) => h.layer === "memory")).toEqual([]);
  });

  it("un marcador de ruido que ya tenía embedding tampoco vuelve por significado", async () => {
    const noise = makeNoiseMarker("[noise] 4 episodios sin señal consolidable de finanzas");
    makeMemory("la deuda del cashflow quedó saldada");
    await embedPendingMemories(db, { embedFn: fakeEmbed, model: "fake" });
    // A db from before the filter already has marker vectors: they must be stopped all the same.
    db.prepare(
      "INSERT INTO memory_embeddings (memory_id, model, dims, vec, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(noise, "fake", 2, Buffer.from(fakeVec("finanzas").buffer), Date.now());

    const result = await recallHybrid(db, { query: "deuda" }, fakeEmbed, { reinforce: false });
    expect(result.hits.map((h) => h.id)).not.toContain(noise);
    expect(result.hits.some((h) => h.text === "la deuda del cashflow quedó saldada")).toBe(true);
  });

  it("un marcador de ruido no gasta un embedding", async () => {
    makeNoiseMarker("[noise] 5 episodios sin señal consolidable");
    makeMemory("la deuda del cashflow quedó saldada");

    const stats = await embedPendingMemories(db, { embedFn: fakeEmbed, model: "fake" });

    expect(stats.pending).toBe(1);
    expect(stats.embedded).toBe(1);
  });

  it("mantiene la propiedad de prefijo entre límites", async () => {
    for (const gist of [
      "deudas uno",
      "deudas dos",
      "cashflow tres",
      "finanzas cuatro",
    ]) {
      makeMemory(gist);
    }
    await embedPendingMemories(db, {
      embedFn: fakeEmbed,
      model: "fake",
    });
    const small = await recallHybrid(
      db,
      { query: "deudas", limit: 2 },
      fakeEmbed,
      { reinforce: false, embeddingModel: "fake" },
    );
    const large = await recallHybrid(
      db,
      { query: "deudas", limit: 4 },
      fakeEmbed,
      { reinforce: false, embeddingModel: "fake" },
    );
    expect(small.hits.map((hit) => hit.id)).toEqual(
      large.hits.slice(0, 2).map((hit) => hit.id),
    );
  });
});

describe("superficies consistentes", () => {
  it("viewer y Engram usan el mismo ranking que recall", async () => {
    makeMemory("cashflow apretado");
    await embedPendingMemories(db, {
      embedFn: fakeEmbed,
      model: "fake",
    });
    const canonical = await recallHybrid(
      db,
      { query: "finanzas", limit: 10 },
      fakeEmbed,
      { reinforce: false, embeddingModel: "fake" },
    );

    const { response, value } = mockResponse();
    await handleSearch(
      db,
      response,
      new URL("http://x/api/search?q=finanzas&limit=10"),
      fakeEmbed,
      "fake",
    );
    const viewer = JSON.parse(value.body) as { hits: Array<{ id: string }> };

    const engram = (await dispatchEngramTool(
      db,
      "mem_search",
      { query: "finanzas", limit: 10 },
      { embedFn: fakeEmbed, embeddingModel: "fake" },
    )) as { hits: Array<{ id: string }> };

    expect(viewer.hits.map((hit) => hit.id)).toEqual(
      canonical.hits.map((hit) => hit.id),
    );
    expect(engram.hits.map((hit) => hit.id)).toEqual(
      canonical.hits.map((hit) => hit.id),
    );
  });

  it("el viewer no refuerza salience", async () => {
    const memoryId = makeMemory("deudas del mes");
    db.prepare("UPDATE memories SET salience = 0.5 WHERE id = ?").run(memoryId);
    const { response } = mockResponse();
    await handleSearch(
      db,
      response,
      new URL("http://x/api/search?q=deudas"),
      fakeEmbed,
      "fake",
    );
    const row = db
      .prepare("SELECT salience FROM memories WHERE id = ?")
      .get(memoryId) as { salience: number };
    expect(row.salience).toBeCloseTo(0.5);
  });
});
