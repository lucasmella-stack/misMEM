import { afterEach, describe, it, expect, beforeEach, vi } from "vitest";
import type { ServerResponse } from "node:http";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/db.js";
import { capture, consolidate, crystallize, reinforce } from "../src/tools.js";
import { saveMemoryEmbedding } from "../src/embeddings/store.js";
import {
  handleEmbeddings,
  handleGraph,
  handleMemories,
  handleMemory,
  handleScopes,
  handleTrait,
  parseDetailPath,
} from "../src/viewer-api.js";
import { relatedLinks } from "../src/relations.js";

const DAY = 86_400_000;
let db: DB;

const EMBED_ENV_KEYS = [
  "MISMEM_EMBEDDINGS",
  "MISMEM_EMBEDDING_PROVIDER",
  "MISMEM_EMBEDDING_URL",
  "MISMEM_OLLAMA_URL",
  "MISMEM_EMBEDDING_MODEL",
] as const;
const savedEmbedEnv = Object.fromEntries(EMBED_ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of EMBED_ENV_KEYS) {
    if (savedEmbedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEmbedEnv[key];
  }
  vi.unstubAllGlobals();
});

function setEmbedEnv(values: Partial<Record<(typeof EMBED_ENV_KEYS)[number], string>>): void {
  for (const key of EMBED_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
}

beforeEach(() => {
  db = openDb(":memory:");
});

interface MockResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  setHeader(name: string, value: string): void;
  end(payload?: string): void;
}

function mockRes(): MockResponse {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(payload) {
      this.body = payload ?? "";
    },
  };
}

interface ApiBody {
  total?: number;
  memories?: Array<{ id: string; stored_salience?: number; salience?: number }>;
  scopes?: unknown;
  memory?: {
    id?: string;
    text?: string;
    use_count?: number;
    embedding?: { model: string; dims: number; created_at: number } | null;
  };

  episodes?: Array<{ id?: string; text?: string; missing?: boolean; linked_here?: boolean }>;
  trait?: { id?: string; text?: string; strength?: number };
  evidence?: Array<{ id?: string; text?: string; missing?: boolean }>;
  traits?: Array<{ id: string }>;
  nodes?: Array<{ id: string; layer: string; co_use?: { degree: number; strength: number } }>;
  links?: Array<{
    source: string;
    target: string;
    kind: string;
    score?: number;
    n?: number;
    strength?: number;
  }>;
  truncated?: { memories: boolean; traits: boolean; episodes: boolean };
  connectome?: {
    turns: number;
    pairs: number;
    shown: number;
    min_n: number;
    hubs: Array<{ id: string; degree: number; strength: number }>;
  };
}

interface EmbeddingBody {
  enabled: boolean;
  provider: string;
  model: string;
  memories: number;
  embedded: number;
  missing: number;
  compatible: number;
  stale_model: number;
  models: Array<{ model: string; dims: number; count: number }>;
}

function call(fn: (res: ServerResponse) => void): { status: number; body: ApiBody } {
  const res = mockRes();
  // mockRes only implements the fields the handlers touch, so it is widened once here.
  fn(res as unknown as ServerResponse);
  return { status: res.statusCode, body: JSON.parse(res.body) as ApiBody };
}

const url = (path: string): URL => new URL(`http://x${path}`);

function memoryFrom(scope: string, gist: string, bodies: string[]): { memoryId: string; episodeIds: string[] } {
  const episodeIds = bodies.map((body) => capture(db, { scope, body }).id);
  const { memory_id } = consolidate(db, { scope, gist, source_episode_ids: episodeIds });
  return { memoryId: memory_id, episodeIds };
}

describe("viewer-api: parseDetailPath", () => {
  it("devuelve capa e id en una ruta de detalle y decodifica el id", () => {
    expect(parseDetailPath("/api/memory/abc")).toEqual({ layer: "memory", id: "abc" });
    expect(parseDetailPath("/api/memory/a%20b")).toEqual({ layer: "memory", id: "a b" });
    expect(parseDetailPath("/api/trait/x")).toEqual({ layer: "trait", id: "x" });
  });

  it("un id mal codificado es un error del cliente, no del servidor", () => {
    expect(parseDetailPath("/api/memory/%")).toBe("bad");
    expect(parseDetailPath("/api/memory/%C3")).toBe("bad");
  });

  it("cualquier otra ruta no es de detalle", () => {
    expect(parseDetailPath("/api/memory/")).toBeNull();
    expect(parseDetailPath("/api/memory/a/b")).toBeNull();
  });
});

describe("viewer-api: /api/embeddings", () => {
  const status = (): EmbeddingBody => call((res) => handleEmbeddings(db, res)).body as unknown as EmbeddingBody;

  it("una base vacía se lee sin llamar al servidor de embeddings", () => {
    setEmbedEnv({ MISMEM_EMBEDDINGS: "off", MISMEM_EMBEDDING_MODEL: "embeddinggemma-2" });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    expect(status()).toMatchObject({
      enabled: false,
      provider: "ollama",
      model: "embeddinggemma-2",
      memories: 0,
      embedded: 0,
      missing: 0,
      compatible: 0,
      stale_model: 0,
      models: [],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("con el índice al día, el ruido no cuenta como sin vector", () => {
    setEmbedEnv({ MISMEM_EMBEDDING_MODEL: "embeddinggemma-2" });
    const { memoryId } = memoryFrom("a", "una memoria", ["e1"]);
    memoryFrom("a", "[noise] lo descartado", ["e2"]);
    saveMemoryEmbedding(db, memoryId, "embeddinggemma-2", Float32Array.from([1, 0, 0]));

    expect(status()).toMatchObject({
      enabled: true,
      memories: 1,
      embedded: 1,
      missing: 0,
      compatible: 1,
      stale_model: 0,
      models: [{ model: "embeddinggemma-2", dims: 3, count: 1 }],
    });
  });

  it("los vectores de otro modelo cuentan como obsoletos, no como ausentes", () => {
    setEmbedEnv({ MISMEM_EMBEDDING_MODEL: "nuevo" });
    const { memoryId } = memoryFrom("a", "una memoria", ["e1"]);
    saveMemoryEmbedding(db, memoryId, "viejo", Float32Array.from([1, 0, 0]));

    expect(status()).toMatchObject({
      memories: 1,
      embedded: 1,
      missing: 0,
      compatible: 0,
      stale_model: 1,
    });
  });

  it("no devuelve la URL del proveedor aunque lleve credenciales", () => {
    // Built at runtime so the fixture never reads as a committed credential to secret scanners.
    const userinfo = ["usuario", "secreto"].join(":");
    setEmbedEnv({
      MISMEM_EMBEDDING_PROVIDER: "openai",
      MISMEM_EMBEDDING_URL: `http://${userinfo}@embed.test/v1`,
      MISMEM_EMBEDDING_MODEL: "embeddinggemma-2",
    });

    const body = status();
    expect(body).toMatchObject({ provider: "openai", model: "embeddinggemma-2" });
    expect(JSON.stringify(body)).not.toContain("usuario");
    expect(JSON.stringify(body)).not.toContain("secreto");
    expect(JSON.stringify(body)).not.toContain("embed.test");
  });
});

describe("viewer-api: /api/scopes", () => {
  it("cuenta por capa y ámbito, sin marcadores de ruido entre las memorias", () => {
    memoryFrom("a", "una memoria", ["ep1", "ep2"]);
    memoryFrom("a", "[noise] 1 episodio sin citar", ["ep3"]);
    capture(db, { scope: "b", body: "pendiente" });
    const { memoryId } = memoryFrom("b", "otra", ["ep4"]);
    crystallize(db, { scope: "b", name: "un rasgo", evidence_memory_ids: [memoryId] });

    const { body } = call((res) => handleScopes(db, res));
    expect(body.scopes).toEqual([
      { scope: "a", episodes_pending: 0, episodes_consolidated: 3, memories: 1, traits: 0 },
      { scope: "b", episodes_pending: 1, episodes_consolidated: 1, memories: 1, traits: 1 },
    ]);
  });
});

describe("viewer-api: /api/memories", () => {
  it("ordena por la salience de hoy, no por la guardada", () => {
    const old = memoryFrom("a", "vieja y olvidada", ["e1"]).memoryId;
    const fresh = memoryFrom("a", "de ayer", ["e2"]).memoryId;
    const now = Date.now();
    db.prepare("UPDATE memories SET salience = 1.0, salience_updated_at = ? WHERE id = ?").run(now - 365 * DAY, old);
    db.prepare("UPDATE memories SET salience = 0.9, salience_updated_at = ? WHERE id = ?").run(now - DAY, fresh);

    const { body } = call((res) => handleMemories(db, res, url("/api/memories"), now));
    expect(body.memories?.map((m) => m.id)).toEqual([fresh, old]);
    expect(body.memories?.[1]?.stored_salience).toBe(1);
    expect(body.memories?.[1]?.salience).toBeLessThan(0.1);
  });

  it("cuenta fuentes, episodios que quedan y rasgos que la citan", () => {
    const { memoryId, episodeIds } = memoryFrom("a", "con fuentes", ["e1", "e2"]);
    db.prepare("DELETE FROM episodes WHERE id = ?").run(episodeIds[0]);
    crystallize(db, { scope: "a", name: "rasgo", evidence_memory_ids: [memoryId] });

    const { body } = call((res) => handleMemories(db, res, url("/api/memories")));
    expect(body.memories?.[0]).toMatchObject({ id: memoryId, sources: 2, episodes_left: 1, traits: 1, noise: false });
  });

  it("filtra por ámbito, esconde el ruido salvo noise=1 y pagina", () => {
    memoryFrom("a", "a uno", ["e1"]);
    memoryFrom("a", "[pareto:l0] 2 episodios filtrados", ["e2"]);
    memoryFrom("b", "b uno", ["e3"]);

    expect(call((res) => handleMemories(db, res, url("/api/memories?scope=a"))).body.total).toBe(1);
    expect(call((res) => handleMemories(db, res, url("/api/memories?scope=a&noise=1"))).body.total).toBe(2);
    const page = call((res) => handleMemories(db, res, url("/api/memories?limit=1&offset=1"))).body;
    expect(page.total).toBe(2);
    expect(page.memories).toHaveLength(1);
  });
});

describe("viewer-api: /api/memory/:id", () => {
  it("devuelve la cadena de origen: episodios y rasgos que la citan", () => {
    const { memoryId, episodeIds } = memoryFrom("a", "la memoria", ["primero", "segundo"]);
    const trait = crystallize(db, { scope: "a", name: "el rasgo", evidence_memory_ids: [memoryId] });

    const { status, body } = call((res) => handleMemory(db, res, memoryId));
    expect(status).toBe(200);
    expect(body.memory).toMatchObject({ id: memoryId, text: "la memoria" });
    expect(body.episodes?.map((e) => [e.id, e.text])).toEqual([
      [episodeIds[0], "primero"],
      [episodeIds[1], "segundo"],
    ]);
    expect(body.traits?.map((t) => t.id)).toEqual([trait.trait_id]);
  });

  it("un episodio que forget ya borró queda marcado, no desaparece", () => {
    const { memoryId, episodeIds } = memoryFrom("a", "la memoria", ["primero", "segundo"]);
    db.prepare("DELETE FROM episodes WHERE id = ?").run(episodeIds[0]);
    const { body } = call((res) => handleMemory(db, res, memoryId));
    expect(body.episodes?.[0]).toEqual({ id: episodeIds[0], missing: true });
    expect(body.episodes?.[1]).toMatchObject({ id: episodeIds[1], linked_here: true });
  });

  it("un id que no existe es 404", () => {
    expect(call((res) => handleMemory(db, res, "NOPE")).status).toBe(404);
  });

  it("trae los usos medidos y el vector con su modelo, dimensiones y fecha", () => {
    const { memoryId } = memoryFrom("a", "la memoria", ["primero"]);
    reinforce(db, { memory_ids: [memoryId] });
    reinforce(db, { memory_ids: [memoryId] });
    saveMemoryEmbedding(db, memoryId, "embeddinggemma-2", Float32Array.from([1, 0, 0]));

    const { body } = call((res) => handleMemory(db, res, memoryId));

    expect(body.memory).toMatchObject({
      use_count: 2,
      embedding: { model: "embeddinggemma-2", dims: 3 },
    });
    expect(body.memory?.embedding?.created_at).toEqual(expect.any(Number));
  });

  it("sin vector, el detalle lo dice con null", () => {
    const { memoryId } = memoryFrom("a", "la memoria", ["primero"]);
    const { body } = call((res) => handleMemory(db, res, memoryId));
    expect(body.memory).toMatchObject({ use_count: 0, embedding: null });
  });
});

describe("viewer-api: /api/trait/:id", () => {
  it("devuelve las memorias que lo sostienen y marca las que ya no existen", () => {
    const { memoryId } = memoryFrom("a", "evidencia", ["e1"]);
    const trait = crystallize(db, { scope: "a", name: "rasgo", evidence_memory_ids: [memoryId, "BORRADA"] });

    const { body } = call((res) => handleTrait(db, res, trait.trait_id));
    expect(body.trait).toMatchObject({ id: trait.trait_id, text: "rasgo", strength: 2 });
    expect(body.evidence?.[0]).toMatchObject({ id: memoryId, text: "evidencia" });
    expect(body.evidence?.[1]).toEqual({ id: "BORRADA", missing: true });
    expect(call((res) => handleTrait(db, res, "NOPE")).status).toBe(404);
  });
});

describe("viewer-api: /api/graph", () => {
  it("nodos y aristas de origen; los episodios sólo si se piden", () => {
    const { memoryId, episodeIds } = memoryFrom("a", "memoria", ["e1"]);
    memoryFrom("a", "[noise] ruido", ["e2"]);
    const trait = crystallize(db, { scope: "a", name: "rasgo", evidence_memory_ids: [memoryId] });

    const plain = call((res) => handleGraph(db, res, url("/api/graph"))).body;
    expect(plain.nodes?.map((n: { id: string; layer: string }) => [n.id, n.layer])).toEqual([
      [memoryId, "memory"],
      [trait.trait_id, "trait"],
    ]);
    expect(plain.links).toEqual([{ source: memoryId, target: trait.trait_id, kind: "evidence" }]);

    const full = call((res) => handleGraph(db, res, url("/api/graph?episodes=1"))).body;
    expect(full.links).toContainEqual({ source: episodeIds[0], target: memoryId, kind: "origin" });
    expect(full.nodes?.some((n: { layer: string }) => n.layer === "episode")).toBe(true);
  });

  it("truncated no da falso positivo con exactamente el tope", () => {
    const { memoryId } = memoryFrom("a", "una", ["e1", "e2"]);
    crystallize(db, { scope: "a", name: "r1", evidence_memory_ids: [memoryId] });

    // Exactamente el tope de cada capa no es un recorte.
    const exact = call((res) =>
      handleGraph(db, res, url("/api/graph?episodes=1"), Date.now(), { memories: 1, traits: 1, episodes: 2 }),
    ).body;
    expect(exact.truncated).toEqual({ memories: false, traits: false, episodes: false });

    memoryFrom("a", "dos", ["e3"]);
    const memoriesOver = call((res) =>
      handleGraph(db, res, url("/api/graph"), Date.now(), { memories: 1 }),
    ).body;
    expect(memoriesOver.truncated).toEqual({ memories: true, traits: false, episodes: false });

    crystallize(db, { scope: "a", name: "r2", evidence_memory_ids: [memoryId] });
    const traitsOver = call((res) =>
      handleGraph(db, res, url("/api/graph"), Date.now(), { traits: 1 }),
    ).body;
    expect(traitsOver.truncated).toEqual({ memories: false, traits: true, episodes: false });

    // Tres episodios para dos de tope; sin episodes=1 la capa ni se pide ni se marca.
    const episodesOver = call((res) =>
      handleGraph(db, res, url("/api/graph?episodes=1"), Date.now(), { episodes: 2 }),
    ).body;
    expect(episodesOver.truncated).toEqual({ memories: false, traits: false, episodes: true });
    const episodesOff = call((res) =>
      handleGraph(db, res, url("/api/graph"), Date.now(), { episodes: 2 }),
    ).body;
    expect(episodesOff.truncated).toEqual({ memories: false, traits: false, episodes: false });
  });
});

describe("viewer-api: aristas por parecido", () => {
  const vec = (...xs: number[]) => Float32Array.from(xs);
  function withVector(gist: string, v: Float32Array, model = "m"): string {
    const { memoryId } = memoryFrom("a", gist, [gist]);
    saveMemoryEmbedding(db, memoryId, model, v);
    return memoryId;
  }

  it("une las memorias parecidas una vez y deja fuera lo que no llega al umbral", () => {
    const a = withVector("luces del teclado", vec(1, 0, 0));
    const b = withVector("nitro-kb controla las luces", vec(0.95, 0.31, 0));
    const c = withVector("la deuda del cashflow", vec(0, 0, 1));

    const links = relatedLinks(db, [a, b, c], { minScore: 0.75 });
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ kind: "related" });
    expect([links[0]?.source, links[0]?.target].sort()).toEqual([a, b].sort());
    expect(links[0]?.score).toBeGreaterThan(0.9);
  });

  it("cada memoria aporta como mucho perNode vecinas", () => {
    // a-b 0,99, a-c 0,97, b-c 0,995: con una vecina por memoria, a elige b, b y c se eligen
    // entre sí, y a-c (que nadie eligió primero) queda fuera.
    const a = withVector("a", vec(1, 0));
    const b = withVector("b", vec(0.99, 0.141));
    const c = withVector("c", vec(0.97, 0.243));
    const pairs = (perNode: number) =>
      relatedLinks(db, [a, b, c], { minScore: 0.9, perNode })
        .map((l) => [l.source, l.target].sort().join("|"))
        .sort();
    expect(pairs(1)).toEqual([[a, b].sort().join("|"), [b, c].sort().join("|")].sort());
    expect(pairs(3)).toHaveLength(3);
  });

  it("no compara vectores de modelos distintos", () => {
    const a = withVector("uno", vec(1, 0), "modelo-a");
    const b = withVector("dos", vec(1, 0), "modelo-a");
    const c = withVector("tres", vec(1, 0), "modelo-b");
    const links = relatedLinks(db, [a, b, c], { minScore: 0.5 });
    expect(links).toHaveLength(1);
    expect([links[0]?.source, links[0]?.target]).not.toContain(c);
  });

  it("/api/graph sólo las incluye con related=1", () => {
    withVector("uno", vec(1, 0));
    withVector("dos", vec(1, 0));
    const plain = call((res) => handleGraph(db, res, url("/api/graph"))).body;
    expect(plain.links?.some((l: { kind: string }) => l.kind === "related")).toBe(false);
    const related = call((res) => handleGraph(db, res, url("/api/graph?related=1"))).body;
    expect(related.links?.filter((l: { kind: string }) => l.kind === "related")).toHaveLength(1);
  });
});

describe("viewer-api: aristas por co-uso", () => {
  function tresUsadas(): { a: string; b: string; suelta: string } {
    const a = memoryFrom("a", "el deploy usa docker compose", ["e1"]).memoryId;
    const b = memoryFrom("a", "el backup corre a las tres", ["e2"]).memoryId;
    const suelta = memoryFrom("a", "el bench corre con el embedder arriba", ["e3"]).memoryId;
    reinforce(db, { memory_ids: [a, b] });
    reinforce(db, { memory_ids: [a, b] });
    reinforce(db, { memory_ids: [a, suelta] });
    return { a, b, suelta };
  }

  it("sin co_use=1 no aparece nada: ni aristas, ni grado, ni resumen", () => {
    // Es el contrato que ya consume la interfaz: no puede cambiar por agregar esto.
    tresUsadas();

    const body = call((res) => handleGraph(db, res, url("/api/graph"))).body;

    expect(body.links!.some((l) => l.kind === "co_use")).toBe(false);
    expect(body.connectome).toBeUndefined();
    expect(body.nodes!.every((n) => n.co_use === undefined)).toBe(true);
  });

  it("pedida, trae el par con su soporte y su fuerza", () => {
    const { a, b } = tresUsadas();

    const body = call((res) => handleGraph(db, res, url("/api/graph?co_use=1"))).body;
    const lateral = body.links!.filter((l) => l.kind === "co_use");

    expect(lateral).toHaveLength(2);
    const fuerte = lateral.find(
      (l) => [l.source, l.target].includes(a) && [l.source, l.target].includes(b),
    );
    expect(fuerte).toMatchObject({ n: 2 });
    expect(typeof fuerte!.strength).toBe("number");
  });

  it("las verticales y las de parecido salen igual con y sin la capa", () => {
    const { a } = tresUsadas();
    crystallize(db, { scope: "a", name: "rasgo", evidence_memory_ids: [a] });

    const sin = call((res) => handleGraph(db, res, url("/api/graph?related=1"))).body.links;
    const con = call((res) => handleGraph(db, res, url("/api/graph?related=1&co_use=1"))).body.links;

    expect(con!.filter((l) => l.kind !== "co_use")).toEqual(sin);
  });

  it("el soporte mínimo saca los pares de una sola vez", () => {
    const { a, b } = tresUsadas();

    const body = call((res) => handleGraph(db, res, url("/api/graph?co_use=1&co_use_min_n=2"))).body;
    const lateral = body.links!.filter((l) => l.kind === "co_use");

    expect(lateral).toHaveLength(1);
    expect([lateral[0]!.source, lateral[0]!.target].sort()).toEqual([a, b].sort());
  });

  it("no deja aristas hacia nodos que no se dibujan", () => {
    const { a } = tresUsadas();
    const afuera = memoryFrom("otro", "memoria de otro ámbito", ["e9"]).memoryId;
    reinforce(db, { memory_ids: [a, afuera] });

    const body = call((res) => handleGraph(db, res, url("/api/graph?scope=a&co_use=1"))).body;
    const dibujados = new Set(body.nodes!.map((n) => n.id));
    const lateral = body.links!.filter((l) => l.kind === "co_use");

    expect(lateral.length).toBeGreaterThan(0);
    for (const l of lateral) {
      expect(dibujados.has(l.source)).toBe(true);
      expect(dibujados.has(l.target)).toBe(true);
    }
    expect(dibujados.has(afuera)).toBe(false);
  });

  it("los nodos traen con qué iluminarse: grado y asociación acumulada", () => {
    const { a } = tresUsadas();

    const body = call((res) => handleGraph(db, res, url("/api/graph?co_use=1"))).body;
    const nodo = body.nodes!.find((n) => n.id === a);

    expect(nodo!.co_use).toMatchObject({ degree: 2 });
    expect(typeof nodo!.co_use!.strength).toBe("number");
  });

  it("el resumen propone por dónde entrar, ordenado por asociación y no por vecinos", () => {
    // El que más vecinos tiene es el que se usa en todos los turnos: no orienta a
    // ninguno. Si los costados lo ponen primero, el panel miente.
    const siempre = memoryFrom("a", "hablamos en español y sin rodeos", ["e1"]).memoryId;
    const v1 = memoryFrom("a", "el deploy usa docker compose", ["e2"]).memoryId;
    const v2 = memoryFrom("a", "el backup corre a las tres", ["e3"]).memoryId;
    const par1 = memoryFrom("a", "el ordenador de memoria tiene tres fases", ["e4"]).memoryId;
    const par2 = memoryFrom("a", "la fase dos espera datos de co-uso", ["e5"]).memoryId;
    for (let i = 0; i < 3; i++) reinforce(db, { memory_ids: [siempre, v1, v2] });
    for (let i = 0; i < 9; i++) reinforce(db, { memory_ids: [siempre] });
    for (let i = 0; i < 3; i++) reinforce(db, { memory_ids: [par1, par2] });

    const body = call((res) => handleGraph(db, res, url("/api/graph?co_use=1"))).body;
    const ranking = body.connectome!.hubs;
    const puesto = (id: string): number => ranking.findIndex((h) => h.id === id);
    const quien = (id: string) => ranking.find((h) => h.id === id)!;

    expect(quien(siempre).degree).toBeGreaterThan(quien(par1).degree);
    expect(puesto(par1)).toBeLessThan(puesto(siempre));
    expect(ranking.map((h) => h.strength)).toEqual(
      [...ranking.map((h) => h.strength)].sort((x, y) => y - x),
    );
  });

  it("el resumen dice de qué tamaño es la muestra, para no mentir en los costados", () => {
    // Con pocos turnos la fuerza es ruido: el panel tiene que poder decirlo.
    tresUsadas();

    const body = call((res) => handleGraph(db, res, url("/api/graph?co_use=1&co_use_min_n=2"))).body;

    expect(body.connectome).toMatchObject({ turns: 3, pairs: 2, shown: 1, min_n: 2 });
  });
});
