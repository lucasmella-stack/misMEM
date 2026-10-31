// Owns the embedding provider config (env) and the HTTP client that turns text into vectors.
// Local Ollama or any OpenAI-compatible server; if it does not answer, everything degrades silently to plain FTS5.

import { envNonNegativeNumber, envPositiveNumber } from "../env.js";

type EmbeddingProvider = "ollama" | "openai";
export type EmbedKind = "query" | "document";

export interface EmbeddingConfig {
  enabled: boolean;
  provider: EmbeddingProvider;
  url: string;
  model: string;
  timeoutMs: number;
  /** Some models (EmbeddingGemma) expect a different prefix for query and document. */
  queryPrefix: string;
  docPrefix: string;
  /** Minimum cosine for a memory to count as similar; it depends on the model. */
  minScore: number;
  /** Cap on each document's text; the gist goes first and is never truncated. */
  maxChars: number;
}

const DEFAULT_MIN_SCORE = 0.5;
// nomic-embed-text scores unrelated texts high: at 0.5 the inject hook adds noise to every prompt.
// Measured in issue #72: 0.65 leaves off-topic queries with 0 memories and loses no hits.
const NOMIC_MIN_SCORE = 0.65;
const OLLAMA_DEFAULT_URL = "http://127.0.0.1:11434";
// llama-server's default port: with the openai provider, Ollama's would answer 404 silently.
const OPENAI_DEFAULT_URL = "http://127.0.0.1:8080";
const DEFAULT_MAX_CHARS = 4000;

export function loadEmbeddingConfig(): EmbeddingConfig {
  const provider: EmbeddingProvider =
    process.env.MISMEM_EMBEDDING_PROVIDER === "openai" ? "openai" : "ollama";
  const model = process.env.MISMEM_EMBEDDING_MODEL ?? "nomic-embed-text";
  // startsWith: Ollama accepts tags (`nomic-embed-text:latest`) and it is the same model.
  const defaultMinScore = model.startsWith("nomic-embed-text") ? NOMIC_MIN_SCORE : DEFAULT_MIN_SCORE;
  return {
    enabled: (process.env.MISMEM_EMBEDDINGS ?? "auto") !== "off",
    provider,
    url:
      process.env.MISMEM_EMBEDDING_URL ??
      (provider === "openai" ? OPENAI_DEFAULT_URL : (process.env.MISMEM_OLLAMA_URL ?? OLLAMA_DEFAULT_URL)),
    model,
    timeoutMs: envPositiveNumber("MISMEM_EMBEDDING_TIMEOUT_MS", 3000),
    queryPrefix: process.env.MISMEM_EMBEDDING_QUERY_PREFIX ?? "",
    docPrefix: process.env.MISMEM_EMBEDDING_DOC_PREFIX ?? "",
    minScore: envNonNegativeNumber("MISMEM_EMBEDDING_MIN_SCORE", defaultMinScore),
    maxChars: envPositiveNumber("MISMEM_EMBEDDING_MAX_CHARS", DEFAULT_MAX_CHARS),
  };
}

export type EmbedFn = (texts: string[]) => Promise<Float32Array[] | null>;

async function requestVectors(
  input: string[],
  cfg: EmbeddingConfig,
): Promise<number[][] | null> {
  const endpoint = cfg.provider === "openai" ? "/v1/embeddings" : "/api/embed";
  const res = await fetch(`${cfg.url}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: cfg.model, input }),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  if (!res.ok) return null;
  if (cfg.provider === "openai") {
    const data = (await res.json()) as { data?: { index: number; embedding: number[] }[] };
    if (!data.data) return null;
    return [...data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
  const data = (await res.json()) as { embeddings?: number[][] };
  return data.embeddings ?? null;
}

/** Asks the configured server for vectors. Returns null on any failure (it never throws). */
export async function embedTexts(
  texts: string[],
  cfg: EmbeddingConfig = loadEmbeddingConfig(),
  kind: EmbedKind = "document",
): Promise<Float32Array[] | null> {
  if (!cfg.enabled || texts.length === 0) return null;
  const prefix = kind === "query" ? cfg.queryPrefix : cfg.docPrefix;
  try {
    const vectors = await requestVectors(texts.map((t) => prefix + t), cfg);
    if (!vectors || vectors.length !== texts.length) return null;
    return vectors.map((e) => Float32Array.from(e));
  } catch {
    return null;
  }
}
