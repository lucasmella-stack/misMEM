/**
 * Owns the embedding provider config (env) and the HTTP client that turns text into vectors.
 *
 * Embeddings via Ollama local (default: nomic-embed-text) o cualquier servidor
 * compatible con OpenAI (`/v1/embeddings`, p. ej. llama-server). Si el servidor
 * no responde, todo degrada silenciosamente a FTS5 puro.
 */

import { envPositiveNumber } from "../env.js";
import { checkedUnitVectors } from "./vector.js";

type EmbeddingProvider = "ollama" | "openai";
export type EmbedKind = "query" | "document";

export interface EmbeddingConfig {
  enabled: boolean;
  provider: EmbeddingProvider;
  url: string;
  model: string;
  timeoutMs: number;
  /** Algunos modelos (EmbeddingGemma) esperan un prefijo distinto para consulta y documento. */
  queryPrefix: string;
  docPrefix: string;
  /** Coseno mínimo para que un recuerdo cuente como parecido; depende del modelo. */
  minScore: number;
  /** Tope del texto de cada documento; el resumen va adelante y nunca se pierde. */
  maxChars: number;
}

const DEFAULT_MIN_SCORE = 0.5;
// nomic-embed-text scores unrelated texts high: at 0.5 the inject hook adds noise to every prompt.
// Measured in issue #72: 0.65 leaves off-topic queries with 0 memories and loses no hits.
const NOMIC_MIN_SCORE = 0.65;
const OLLAMA_DEFAULT_URL = "http://127.0.0.1:11434";
// El puerto por defecto de llama-server: con el proveedor openai, el de Ollama respondería 404 en silencio.
const OPENAI_DEFAULT_URL = "http://127.0.0.1:8080";
const DEFAULT_MAX_CHARS = 4000;

export function loadEmbeddingConfig(): EmbeddingConfig {
  const provider: EmbeddingProvider =
    process.env.MISMEM_EMBEDDING_PROVIDER === "openai" ? "openai" : "ollama";
  // Number("") es 0: sin la variable no hay corte elegido, y 0 sí es una elección válida (traer todo).
  const minScore = Number(process.env.MISMEM_EMBEDDING_MIN_SCORE || Number.NaN);
  const maxChars = Number(process.env.MISMEM_EMBEDDING_MAX_CHARS);
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
    minScore: Number.isFinite(minScore) && minScore >= 0 ? minScore : defaultMinScore,
    maxChars: Number.isFinite(maxChars) && maxChars > 0 ? maxChars : DEFAULT_MAX_CHARS,
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

/** Pide los vectores al servidor configurado. Devuelve null ante cualquier fallo (sin throw). */
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
    // A poisoned batch is a failed batch, like a server that does not answer: storing a
    // NaN vector would drop that memory from search with no warning at all.
    return checkedUnitVectors(vectors);
  } catch {
    return null;
  }
}
