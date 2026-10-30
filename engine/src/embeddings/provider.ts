/**
 * Owns the embedding provider config (env) and the HTTP client that turns text into vectors.
 *
 * Embeddings via Ollama local (default: nomic-embed-text) o cualquier servidor
 * compatible con OpenAI (`/v1/embeddings`, p. ej. llama-server). Si el servidor
 * no responde, todo degrada silenciosamente a FTS5 puro.
 */

import { createHash } from "node:crypto";
import { envPositiveNumber } from "../env.js";

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
// embeddinggemma-2 too: on the golden eval, 0.5 brings 5 memories to each of the 48 off-topic
// questions; 0.65 leaves 37 of 48 with nothing and loses no hit, 0.66 already loses one (issue #158).
const GEMMA_MIN_SCORE = 0.65;
// Matched by family name anywhere in the id: llama-server, TEI and vLLM take free ids such as
// `google/embeddinggemma-300m` or a GGUF path, and Ollama adds tags (`nomic-embed-text:latest`).
const MODEL_MIN_SCORES: ReadonlyArray<readonly [family: string, minScore: number]> = [
  ["nomic-embed-text", NOMIC_MIN_SCORE],
  ["embeddinggemma", GEMMA_MIN_SCORE],
];
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
  const family = model.toLowerCase();
  const defaultMinScore =
    MODEL_MIN_SCORES.find(([name]) => family.includes(name))?.[1] ?? DEFAULT_MIN_SCORE;
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

/**
 * Text exactly as the embedder receives a document: the configured prefix plus the stored
 * text cut at maxChars. Both the request and the fingerprint go through here so a change in
 * one cannot leave the other describing a different string.
 */
function documentText(text: string, cfg: EmbeddingConfig): string {
  return cfg.docPrefix + text.slice(0, cfg.maxChars);
}

/**
 * sha256 (hex, first 16 chars) of the exact document text. Keeping it on the row lets the
 * backfill tell a vector that describes its text from one left behind by an edit or by a
 * change of prefix or maxChars; the model and the dims alone cannot see either.
 */
export function embeddingFingerprint(text: string, cfg: EmbeddingConfig): string {
  return createHash("sha256").update(documentText(text, cfg)).digest("hex").slice(0, 16);
}

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
  const input =
    kind === "query"
      ? texts.map((t) => cfg.queryPrefix + t)
      : texts.map((t) => documentText(t, cfg));
  try {
    const vectors = await requestVectors(input, cfg);
    if (!vectors || vectors.length !== texts.length) return null;
    return vectors.map((e) => Float32Array.from(e));
  } catch {
    return null;
  }
}
