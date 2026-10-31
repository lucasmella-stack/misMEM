import { afterEach, describe, expect, it, vi } from "vitest";
import {
  distill,
  loadLlmConfig,
  LlmFatalError,
  LlmInvalidJsonError,
  LlmTruncatedError,
} from "../src/consolidation/llm.js";

const ENV_KEYS = [
  "DEEPSEEK_API_KEY",
  "OPENROUTER_API_KEY",
  "MISMEM_CONSOLIDATION_MODEL",
  "MISMEM_CONSOLIDATION_MAX_TOKENS",
  "MISMEM_CONSOLIDATION_TIMEOUT_MS",
  "MISMEM_LLM_PROVIDER",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "MISMEM_LLM_BASE_URL",
  "MISMEM_LLM_API_KEY",
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

describe("loadLlmConfig", () => {
  it("con DEEPSEEK_API_KEY va directo a DeepSeek, aunque también haya OpenRouter", () => {
    setEnv({ DEEPSEEK_API_KEY: "sk-ds", OPENROUTER_API_KEY: "sk-or" });
    const cfg = loadLlmConfig();
    expect(cfg.apiKey).toBe("sk-ds");
    expect(cfg.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(cfg.model).toBe("deepseek-chat");
  });

  it("en DeepSeek ignora un modelo con nombre de OpenRouter y respeta uno propio", () => {
    setEnv({ DEEPSEEK_API_KEY: "sk-ds", MISMEM_CONSOLIDATION_MODEL: "deepseek/deepseek-chat" });
    expect(loadLlmConfig().model).toBe("deepseek-chat");
    setEnv({ DEEPSEEK_API_KEY: "sk-ds", MISMEM_CONSOLIDATION_MODEL: "deepseek-reasoner" });
    expect(loadLlmConfig().model).toBe("deepseek-reasoner");
  });

  it("sin DeepSeek sigue usando OpenRouter", () => {
    setEnv({ OPENROUTER_API_KEY: "sk-or" });
    const cfg = loadLlmConfig();
    expect(cfg.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(cfg.model).toBe("deepseek/deepseek-chat");
  });

  it("sin ninguna clave avisa de las dos", () => {
    setEnv({});
    expect(() => loadLlmConfig()).toThrow(/DEEPSEEK_API_KEY.*OPENROUTER_API_KEY/);
  });

  it("pone un tope a la respuesta: 8192 tokens salvo que se configure otro", () => {
    setEnv({ DEEPSEEK_API_KEY: "sk-ds" });
    expect(loadLlmConfig().maxTokens).toBe(8192);
    setEnv({ DEEPSEEK_API_KEY: "sk-ds", MISMEM_CONSOLIDATION_MAX_TOKENS: "2000" });
    expect(loadLlmConfig().maxTokens).toBe(2000);
  });
});

describe("timeout del LLM", () => {
  const dummy = "x";

  it("120 s por defecto, configurable", () => {
    setEnv({ DEEPSEEK_API_KEY: dummy });
    expect(loadLlmConfig().timeoutMs).toBe(120_000);
    setEnv({ DEEPSEEK_API_KEY: dummy, MISMEM_CONSOLIDATION_TIMEOUT_MS: "30000" });
    expect(loadLlmConfig().timeoutMs).toBe(30_000);
    setEnv({ OPENROUTER_API_KEY: dummy, MISMEM_CONSOLIDATION_TIMEOUT_MS: "abc" });
    expect(loadLlmConfig().timeoutMs).toBe(120_000);
  });
});

describe("proveedores", () => {
  const key = "x";

  it("sin MISMEM_LLM_PROVIDER, el orden de siempre: DeepSeek, OpenRouter, OpenAI, compatible", () => {
    setEnv({ OPENROUTER_API_KEY: key, OPENAI_API_KEY: key });
    expect(loadLlmConfig().baseUrl).toBe("https://openrouter.ai/api/v1");
    setEnv({ OPENAI_API_KEY: key, MISMEM_CONSOLIDATION_MODEL: "un-modelo" });
    expect(loadLlmConfig().baseUrl).toBe("https://api.openai.com/v1");
    setEnv({ MISMEM_LLM_BASE_URL: "http://127.0.0.1:11434/v1/", MISMEM_CONSOLIDATION_MODEL: "qwen3" });
    expect(loadLlmConfig()).toMatchObject({ baseUrl: "http://127.0.0.1:11434/v1", apiKey: "", model: "qwen3" });
  });

  it("MISMEM_LLM_PROVIDER manda aunque haya otras claves", () => {
    setEnv({ DEEPSEEK_API_KEY: key, OPENAI_API_KEY: key, MISMEM_LLM_PROVIDER: "openai", MISMEM_CONSOLIDATION_MODEL: "m" });
    expect(loadLlmConfig().baseUrl).toBe("https://api.openai.com/v1");
  });

  it("con OpenAI o compatible el modelo es obligatorio", () => {
    setEnv({ OPENAI_API_KEY: key });
    expect(() => loadLlmConfig()).toThrow(/MISMEM_CONSOLIDATION_MODEL/);
    setEnv({ MISMEM_LLM_BASE_URL: "http://localhost:8000/v1" });
    expect(() => loadLlmConfig()).toThrow(/MISMEM_CONSOLIDATION_MODEL/);
  });

  it("un proveedor elegido sin su variable dice cuál falta", () => {
    setEnv({ MISMEM_LLM_PROVIDER: "openai", MISMEM_CONSOLIDATION_MODEL: "m" });
    expect(() => loadLlmConfig()).toThrow(/falta OPENAI_API_KEY/);
    setEnv({ MISMEM_LLM_PROVIDER: "compatible", MISMEM_CONSOLIDATION_MODEL: "m" });
    expect(() => loadLlmConfig()).toThrow(/falta MISMEM_LLM_BASE_URL/);
    setEnv({ MISMEM_LLM_PROVIDER: "otra-cosa" });
    expect(() => loadLlmConfig()).toThrow(/no existe/);
  });

  it("sin ninguno enumera las cuatro opciones", () => {
    setEnv({});
    expect(() => loadLlmConfig()).toThrow(/OPENAI_API_KEY.*MISMEM_LLM_BASE_URL/);
  });

  it("un servidor sin clave no recibe Authorization", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"memories":[]}' } }] })),
    );
    vi.stubGlobal("fetch", fetchMock);
    await distill({ apiKey: "", model: "m", baseUrl: "http://127.0.0.1:11434/v1" }, "sys", "user");
    expect(fetchMock.mock.calls[0]![1].headers).not.toHaveProperty("Authorization");
  });
});

describe("distill", () => {
  const cfg = { apiKey: "k", model: "deepseek-chat", baseUrl: "https://llm.test/v1", maxTokens: 1234 };

  it("un proveedor que no responde corta en el tope en vez de colgar la corrida", async () => {
    // It accepts the request and never answers: only an aborted signal ends it.
    const hang = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    vi.stubGlobal("fetch", hang);
    const started = Date.now();
    await expect(distill({ ...cfg, timeoutMs: 50 }, "sys", "user")).rejects.toThrow(/sin respuesta en 50 ms/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("manda el tope de tokens en el pedido", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"memories":[]}' } }] })),
    );
    vi.stubGlobal("fetch", fetchMock);
    await distill(cfg, "sys", "user");
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.max_tokens).toBe(1234);
  });

  it.each([401, 402, 403])("un HTTP %i es fatal: no tiene sentido seguir con otros ámbitos", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("sin saldo", { status })));
    await expect(distill(cfg, "sys", "user")).rejects.toBeInstanceOf(LlmFatalError);
  });

  it("una respuesta cortada por el tope de tokens se distingue de un JSON roto", async () => {
    const cut = '{"memories":[{"gist":"algo","details":"sin terminar';
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: cut } }] })),
      ),
    );
    await expect(distill(cfg, "sys", "user")).rejects.toBeInstanceOf(LlmTruncatedError);
  });

  it("un JSON mal armado (sin estar cortado) se distingue para poder partir la tanda", async () => {
    const broken = '{"memories":[{"gist":"a","evidence_episode_ids":["x"]} {"gist":"b"}]}';
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: broken } }] })),
      ),
    );
    await expect(distill(cfg, "sys", "user")).rejects.toBeInstanceOf(LlmInvalidJsonError);
  });

  const answer = (content: string): Response =>
    new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }));

  it("devuelve las memorias que destiló el LLM", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        answer('```json\n{"memories":[{"gist":"Prefiere Postgres","evidence_episode_ids":["e1"]}]}\n```'),
      ),
    );
    expect(await distill(cfg, "sys", "user")).toEqual([{ gist: "Prefiere Postgres", evidence_episode_ids: ["e1"] }]);
  });

  it("un resumen largo no se descarta: lo que no entra en el gist pasa a los detalles", async () => {
    const long = "Decisión sobre el despliegue. ".repeat(30);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        answer(JSON.stringify({ memories: [{ gist: long, details: "contexto", evidence_episode_ids: ["e1"] }] })),
      ),
    );
    const [memory] = await distill(cfg, "sys", "user");
    expect(memory?.gist.length).toBeLessThanOrEqual(500);
    expect(memory?.details).toContain(long.trim());
    expect(memory?.details).toContain("contexto");
  });

  it("una memoria mal formada no se pierde en silencio: la respuesta entera cuenta como inválida", async () => {
    const mixed = JSON.stringify({
      memories: [{ gist: "buena", evidence_episode_ids: ["e1"] }, { gist: "sin evidencia" }],
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(answer(mixed)));
    await expect(distill(cfg, "sys", "user")).rejects.toBeInstanceOf(LlmInvalidJsonError);
  });

  it("un JSON válido sin la lista de memorias también se puede reintentar partiendo la tanda", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(answer('{"resultado":"ok"}')));
    await expect(distill(cfg, "sys", "user")).rejects.toBeInstanceOf(LlmInvalidJsonError);
  });

  it("el error de un JSON roto no arrastra el contenido de la respuesta", async () => {
    const secret = "el usuario contó algo privado";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(answer(`{"memories":[{"gist":"${secret}" "roto"}]}`)));
    const err = (await distill(cfg, "sys", "user").catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(LlmInvalidJsonError);
    expect(err.message).not.toContain(secret);
  });

  it("un 500 no es fatal", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("boom", { status: 500 })));
    const err = await distill(cfg, "sys", "user").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(LlmFatalError);
  });
});
