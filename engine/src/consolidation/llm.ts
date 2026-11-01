import { z } from "zod";
import { envPositiveNumber } from "../env.js";

const MAX_GIST_CHARS = 500;

const MemorySchema = z.object({
  gist: z.string().min(1),
  details: z.string().optional().nullable(),
  evidence_episode_ids: z.array(z.string()).min(1),
  type: z.string().min(1).max(40).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export type DistilledMemory = z.infer<typeof MemorySchema>;

export interface LlmConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  appUrl?: string;
  appTitle?: string;
  maxTokens?: number;
  /** Per-call cap: without it, a provider that accepts and never answers hung the run. */
  timeoutMs?: number;
}

// deepseek-chat's output maximum: anything lower truncates answers for large batches.
const DEFAULT_MAX_TOKENS = 8192;

/** Credentials or balance: retrying with another scope would give the same error. */
export class LlmFatalError extends Error {
  override name = "LlmFatalError";
}

/** The answer hit the token cap: fewer episodes make it fit. */
export class LlmTruncatedError extends Error {
  override name = "LlmTruncatedError";
}

/** The answer is not valid JSON: a smaller batch usually goes through. */
export class LlmInvalidJsonError extends Error {
  override name = "LlmInvalidJsonError";
}

// Plenty for 8192 tokens; anything slower is a hung provider.
const DEFAULT_TIMEOUT_MS = 120_000;

function loadTimeoutMs(): number {
  return envPositiveNumber("MISMEM_CONSOLIDATION_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
}

function loadMaxTokens(): number {
  return envPositiveNumber("MISMEM_CONSOLIDATION_MAX_TOKENS", DEFAULT_MAX_TOKENS);
}

type LlmProvider = "deepseek" | "openrouter" | "openai" | "compatible";

const PROVIDERS: readonly LlmProvider[] = ["deepseek", "openrouter", "openai", "compatible"];

/** Without MISMEM_LLM_PROVIDER, the first one with its variable set, in the usual order. */
function pickProvider(): LlmProvider | undefined {
  const explicit = process.env.MISMEM_LLM_PROVIDER?.trim().toLowerCase();
  if (explicit) {
    if (!(PROVIDERS as readonly string[]).includes(explicit)) {
      throw new Error(`MISMEM_LLM_PROVIDER=${explicit} no existe: usar ${PROVIDERS.join(", ")}`);
    }
    return explicit as LlmProvider;
  }
  if (process.env.DEEPSEEK_API_KEY) return "deepseek";
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.MISMEM_LLM_BASE_URL) return "compatible";
  return undefined;
}

function required(name: string, provider: LlmProvider): string {
  const value = process.env[name];
  if (!value) throw new Error(`Con el proveedor ${provider} falta ${name}.`);
  return value;
}

/**
 * With OpenAI or a compatible server no default model is valid: choosing it is the cost
 * decision of whoever pays, and a name fixed here would go stale.
 */
function requiredModel(provider: LlmProvider): string {
  const model = process.env.MISMEM_CONSOLIDATION_MODEL;
  if (!model) throw new Error(`Con el proveedor ${provider} hay que elegir el modelo en MISMEM_CONSOLIDATION_MODEL.`);
  return model;
}

export function loadLlmConfig(): LlmConfig {
  const configured = process.env.MISMEM_CONSOLIDATION_MODEL;
  const limits = { maxTokens: loadMaxTokens(), timeoutMs: loadTimeoutMs() };
  const provider = pickProvider();
  switch (provider) {
    case "deepseek":
      return {
        apiKey: required("DEEPSEEK_API_KEY", provider),
        // "deepseek/deepseek-chat" is the OpenRouter name; DeepSeek does not accept it.
        model: configured && !configured.includes("/") ? configured : "deepseek-chat",
        baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1",
        ...limits,
      };
    case "openrouter":
      return {
        apiKey: required("OPENROUTER_API_KEY", provider),
        model: configured ?? "deepseek/deepseek-chat",
        baseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
        appUrl: process.env.OPENROUTER_APP_URL ?? "https://github.com/lucasmella-stack/misMEM",
        appTitle: process.env.OPENROUTER_APP_TITLE ?? "misMEM",
        ...limits,
      };
    case "openai":
      return {
        apiKey: required("OPENAI_API_KEY", provider),
        model: requiredModel(provider),
        baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
        ...limits,
      };
    case "compatible":
      return {
        // A local server (Ollama, LM Studio, vLLM) may not ask for a key.
        apiKey: process.env.MISMEM_LLM_API_KEY ?? "",
        model: requiredModel(provider),
        baseUrl: required("MISMEM_LLM_BASE_URL", provider).replace(/\/+$/, ""),
        ...limits,
      };
    default:
      throw new Error(
        "Falta un proveedor para consolidar: DEEPSEEK_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY " +
          "o MISMEM_LLM_BASE_URL (un servidor compatible con la API de OpenAI). Ver MISMEM_LLM_PROVIDER.",
      );
  }
}

export async function distill(
  cfg: LlmConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<DistilledMemory[]> {
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // The same signal also cuts the body read, which is where a half-done stream hangs.
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await request(cfg, systemPrompt, userPrompt, signal);
  } catch (err) {
    if ((err as Error)?.name === "TimeoutError") {
      throw new Error(`LLM sin respuesta en ${timeoutMs} ms`);
    }
    throw err;
  }
}

async function request(
  cfg: LlmConfig,
  systemPrompt: string,
  userPrompt: string,
  signal: AbortSignal,
): Promise<DistilledMemory[]> {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    signal,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      ...(cfg.appUrl ? { "HTTP-Referer": cfg.appUrl } : {}),
      ...(cfg.appTitle ? { "X-Title": cfg.appTitle } : {}),
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    const message = `LLM HTTP ${res.status}: ${text.slice(0, 500)}`;
    if (res.status === 401 || res.status === 402 || res.status === 403) {
      throw new LlmFatalError(message);
    }
    throw new Error(message);
  }

  const json = (await res.json()) as {
    choices?: { finish_reason?: string; message?: { content?: string } }[];
  };
  const choice = json.choices?.[0];
  if (choice?.finish_reason === "length") {
    throw new LlmTruncatedError(`respuesta cortada en ${cfg.maxTokens ?? DEFAULT_MAX_TOKENS} tokens`);
  }
  const content = choice?.message?.content;
  if (!content) {
    throw new Error("Respuesta del LLM sin choices[0].message.content");
  }

  const cleaned = stripFences(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    // Without the response text: these are the person's memories and this error ends up in a log.
    throw new LlmInvalidJsonError(
      `LLM devolvi\u00f3 JSON inv\u00e1lido (${cleaned.length} caracteres): ${(err as Error).name}`,
    );
  }
  const root = z.object({ memories: z.array(z.unknown()) }).safeParse(parsed);
  if (!root.success) {
    throw new LlmInvalidJsonError("la respuesta del LLM no trae la lista de memorias");
  }
  const memories = root.data.memories.map((raw) => MemorySchema.safeParse(raw));
  const invalid = memories.filter((m) => !m.success).length;
  if (invalid > 0) {
    // Keeping only the valid ones would leave the other episodes uncited, and therefore as noise.
    throw new LlmInvalidJsonError(`${invalid} de ${memories.length} memorias del LLM mal formadas`);
  }
  return memories.flatMap((m) => (m.success ? [fitGist(m.data)] : []));
}

function fitGist(memory: DistilledMemory): DistilledMemory {
  if (memory.gist.length <= MAX_GIST_CHARS) return memory;
  return {
    ...memory,
    gist: memory.gist.slice(0, MAX_GIST_CHARS),
    details: [memory.gist.trim(), memory.details].filter(Boolean).join("\n"),
  };
}

function stripFences(s: string): string {
  const trimmed = s.trim();
  if (trimmed.startsWith("```")) {
    return trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();
  }
  return trimmed;
}
