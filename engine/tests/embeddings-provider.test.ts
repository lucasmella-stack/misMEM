import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { capture, consolidate, recallHybrid } from "../src/tools.js";
import { embedPendingMemories } from "../src/embeddings/store.js";
import { embedTexts, loadEmbeddingConfig } from "../src/embeddings/provider.js";

const ENV_KEYS = [
  "MISMEM_EMBEDDINGS",
  "MISMEM_EMBEDDING_PROVIDER",
  "MISMEM_EMBEDDING_URL",
  "MISMEM_OLLAMA_URL",
  "MISMEM_EMBEDDING_MODEL",
  "MISMEM_EMBEDDING_QUERY_PREFIX",
  "MISMEM_EMBEDDING_DOC_PREFIX",
  "MISMEM_EMBEDDING_MIN_SCORE",
  "MISMEM_EMBEDDING_TIMEOUT_MS",
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, values);
}

function openAiResponse(vectors: number[][]): Response {
  // Desordenado a propósito: el orden lo da `index`, no la posición.
  const data = vectors.map((embedding, index) => ({ index, embedding })).reverse();
  return new Response(JSON.stringify({ data }));
}

const GEMMA_ENV = {
  MISMEM_EMBEDDING_PROVIDER: "openai",
  MISMEM_EMBEDDING_URL: "http://embed.test",
  MISMEM_EMBEDDING_MODEL: "embeddinggemma-2",
  MISMEM_EMBEDDING_QUERY_PREFIX: "task: search result | query: ",
  MISMEM_EMBEDDING_DOC_PREFIX: "title: none | text: ",
};

describe("loadEmbeddingConfig", () => {
  it("sin configurar sigue siendo Ollama con nomic, sin prefijos y corte 0,65", () => {
    setEnv({});
    const cfg = loadEmbeddingConfig();
    expect(cfg.provider).toBe("ollama");
    expect(cfg.url).toBe("http://127.0.0.1:11434");
    expect(cfg.model).toBe("nomic-embed-text");
    expect(cfg.queryPrefix).toBe("");
    expect(cfg.docPrefix).toBe("");
    expect(cfg.minScore).toBe(0.65);
  });

  it("MISMEM_OLLAMA_URL sigue valiendo para Ollama", () => {
    setEnv({ MISMEM_OLLAMA_URL: "http://ollama:11434" });
    expect(loadEmbeddingConfig().url).toBe("http://ollama:11434");
  });

  it("un corte 0 es una elección (traer todo), no un valor ausente", () => {
    setEnv({ MISMEM_EMBEDDING_MIN_SCORE: "0" });
    expect(loadEmbeddingConfig().minScore).toBe(0);
  });

  it.each(["alto", ""])("un corte que no es un número (%j) vuelve al default del modelo", (value) => {
    setEnv({ MISMEM_EMBEDDING_MIN_SCORE: value });
    expect(loadEmbeddingConfig().minScore).toBe(0.65);
    setEnv({ MISMEM_EMBEDDING_MIN_SCORE: value, MISMEM_EMBEDDING_MODEL: "embeddinggemma-2" });
    expect(loadEmbeddingConfig().minScore).toBe(0.65);
    setEnv({ MISMEM_EMBEDDING_MIN_SCORE: value, MISMEM_EMBEDDING_MODEL: "bge-m3" });
    expect(loadEmbeddingConfig().minScore).toBe(0.5);
  });

  it.each([
    "embeddinggemma-2",
    "embeddinggemma-2:Q8_0",
    "google/embeddinggemma-300m",
    "EmbeddingGemma-300M",
    "/models/embeddinggemma-2-Q8_0.gguf",
  ])(
    "con %s y sin corte elegido, el default es 0,65 (medido en el golden eval)",
    (model) => {
      setEnv({ MISMEM_EMBEDDING_MODEL: model });
      expect(loadEmbeddingConfig().minScore).toBe(0.65);
    },
  );

  it.each(["nomic-embed-text", "nomic-embed-text:latest"])(
    "con %s y sin corte elegido, el default es 0,65",
    (model) => {
      setEnv({ MISMEM_EMBEDDING_MODEL: model });
      expect(loadEmbeddingConfig().minScore).toBe(0.65);
    },
  );

  it("un corte explícito gana al default de nomic", () => {
    setEnv({ MISMEM_EMBEDDING_MODEL: "nomic-embed-text", MISMEM_EMBEDDING_MIN_SCORE: "0.5" });
    expect(loadEmbeddingConfig().minScore).toBe(0.5);
    setEnv({ MISMEM_EMBEDDING_MODEL: "nomic-embed-text", MISMEM_EMBEDDING_MIN_SCORE: "0" });
    expect(loadEmbeddingConfig().minScore).toBe(0);
  });

  it("los demás modelos conservan el default de 0,5", () => {
    setEnv({ MISMEM_EMBEDDING_MODEL: "bge-m3" });
    expect(loadEmbeddingConfig().minScore).toBe(0.5);
    setEnv({ MISMEM_EMBEDDING_MODEL: "mxbai-embed-large" });
    expect(loadEmbeddingConfig().minScore).toBe(0.5);
  });

  it("el proveedor openai sin URL no le habla al puerto de Ollama", () => {
    setEnv({ MISMEM_EMBEDDING_PROVIDER: "openai", MISMEM_OLLAMA_URL: "http://ollama:11434" });
    expect(loadEmbeddingConfig().url).toBe("http://127.0.0.1:8080");
  });

  it("un timeout válido se respeta", () => {
    setEnv({ MISMEM_EMBEDDING_TIMEOUT_MS: "250" });
    expect(loadEmbeddingConfig().timeoutMs).toBe(250);
  });

  it.each(["-5", "abc", ""])(
    "un timeout imposible (%j) vuelve a 3000 en vez de romper AbortSignal",
    (value) => {
      setEnv({ MISMEM_EMBEDDING_TIMEOUT_MS: value });
      expect(loadEmbeddingConfig().timeoutMs).toBe(3000);
    },
  );

  it("lee proveedor, URL, prefijos y corte", () => {
    setEnv({ ...GEMMA_ENV, MISMEM_EMBEDDING_MIN_SCORE: "0.68" });
    const cfg = loadEmbeddingConfig();
    expect(cfg.provider).toBe("openai");
    expect(cfg.url).toBe("http://embed.test");
    expect(cfg.queryPrefix).toBe("task: search result | query: ");
    expect(cfg.docPrefix).toBe("title: none | text: ");
    expect(cfg.minScore).toBe(0.68);
  });
});

describe("embedTexts con un servidor compatible con OpenAI", () => {
  it("pide /v1/embeddings con el prefijo de consulta y respeta el orden por index", async () => {
    setEnv(GEMMA_ENV);
    const fetchMock = vi.fn().mockResolvedValue(openAiResponse([[1, 0], [0, 1]]));
    vi.stubGlobal("fetch", fetchMock);

    const vecs = await embedTexts(["a", "b"], loadEmbeddingConfig(), "query");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://embed.test/v1/embeddings");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "embeddinggemma-2",
      input: ["task: search result | query: a", "task: search result | query: b"],
    });
    expect(vecs?.map((v) => Array.from(v))).toEqual([[1, 0], [0, 1]]);
  });

  it("a los documentos les pone el prefijo de documento", async () => {
    setEnv(GEMMA_ENV);
    const fetchMock = vi.fn().mockResolvedValue(openAiResponse([[1, 0]]));
    vi.stubGlobal("fetch", fetchMock);

    await embedTexts(["nota"], loadEmbeddingConfig());

    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string).input).toEqual([
      "title: none | text: nota",
    ]);
  });

  it("un servidor caído devuelve null, como con Ollama", async () => {
    setEnv(GEMMA_ENV);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("boom", { status: 500 })));
    expect(await embedTexts(["a"], loadEmbeddingConfig(), "query")).toBeNull();
  });
});

describe("Ollama no cambia", () => {
  it("pide /api/embed sin prefijos", async () => {
    setEnv({ MISMEM_OLLAMA_URL: "http://ollama.test" });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ embeddings: [[1, 0]] })));
    vi.stubGlobal("fetch", fetchMock);

    await embedTexts(["a"], loadEmbeddingConfig(), "query");

    expect(fetchMock.mock.calls[0]![0]).toBe("http://ollama.test/api/embed");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string).input).toEqual(["a"]);
  });
});

describe("recall con el proveedor configurado", () => {
  it("indexa con prefijo de documento, busca con el de consulta y aplica el corte configurado", async () => {
    setEnv({ ...GEMMA_ENV, MISMEM_EMBEDDING_MIN_SCORE: "0.9" });
    const vectors: Record<string, number[]> = {
      "title: none | text: fechas de postgres": [1, 0],
      "title: none | text: receta de cocina": [0.6, 0.8],
      "task: search result | query: zona horaria": [1, 0],
    };
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const { input } = JSON.parse(init.body) as { input: string[] };
      return openAiResponse(input.map((t) => vectors[t] ?? [0, 1]));
    });
    vi.stubGlobal("fetch", fetchMock);

    const db = openDb(":memory:");
    const make = (gist: string) =>
      consolidate(db, {
        scope: "t",
        gist,
        source_episode_ids: [capture(db, { scope: "t", body: `src ${gist}` }).id],
      }).memory_id;
    const close = make("fechas de postgres");
    make("receta de cocina");
    await embedPendingMemories(db);

    const { hits } = await recallHybrid(db, { query: "zona horaria", limit: 5 }, undefined, {
      reinforce: false,
    });
    expect(hits.map((h) => h.id)).toEqual([close]);
  });
});
