// Owns the embedding config (env) and the HTTP client that turns text into vectors.
// One protocol, OpenAI's /v1/embeddings, which llama-server and Ollama both serve; if nothing answers,
// everything degrades silently to plain FTS5.

import { createHash } from "node:crypto";
import { envNonNegativeNumber, envPositiveNumber } from "../env.js";
import { checkedUnitVectors } from "./vector.js";

export type EmbedKind = "query" | "document";

export interface EmbeddingConfig {
  enabled: boolean;
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
// EmbeddingGemma scores unrelated texts high: at 0.5 every off-topic question got 5 memories.
// 0.65 is the highest cut that loses no hit in the golden eval (PR #181).
const GEMMA_MIN_SCORE = 0.65;
// llama-server's default port, the one scripts/install.sh serves EmbeddingGemma 2 on.
const DEFAULT_URL = "http://127.0.0.1:8080";
const DEFAULT_MODEL = "embeddinggemma-2";
// EmbeddingGemma was trained with these task prefixes; without them it ranks worse (issue #72).
const GEMMA_QUERY_PREFIX = "task: search result | query: ";
const GEMMA_DOC_PREFIX = "title: none | text: ";
const DEFAULT_MAX_CHARS = 4000;

export function loadEmbeddingConfig(): EmbeddingConfig {
  const model = process.env.MISMEM_EMBEDDING_MODEL ?? DEFAULT_MODEL;
  // Any id of the family (a GGUF path, `google/embeddinggemma-300m`): servers accept free ids.
  // Another model starts without prefixes, Gemma's would be noise in its input, and with the generic cut.
  const gemma = /embeddinggemma/i.test(model);
  return {
    enabled: (process.env.MISMEM_EMBEDDINGS ?? "auto") !== "off",
    url: process.env.MISMEM_EMBEDDING_URL ?? DEFAULT_URL,
    model,
    timeoutMs: envPositiveNumber("MISMEM_EMBEDDING_TIMEOUT_MS", 3000),
    queryPrefix: process.env.MISMEM_EMBEDDING_QUERY_PREFIX ?? (gemma ? GEMMA_QUERY_PREFIX : ""),
    docPrefix: process.env.MISMEM_EMBEDDING_DOC_PREFIX ?? (gemma ? GEMMA_DOC_PREFIX : ""),
    minScore: envNonNegativeNumber("MISMEM_EMBEDDING_MIN_SCORE", gemma ? GEMMA_MIN_SCORE : DEFAULT_MIN_SCORE),
    maxChars: envPositiveNumber("MISMEM_EMBEDDING_MAX_CHARS", DEFAULT_MAX_CHARS),
  };
}

export type EmbedFn = (
  texts: string[],
) => Promise<Array<Float32Array | null> | null>;

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
  const res = await fetch(`${cfg.url}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: cfg.model, input }),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { data?: { index: number; embedding: number[] }[] };
  if (!data.data) return null;
  return [...data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

/** Asks the configured server for vectors. Returns null on any failure (it never throws). */
export async function embedTexts(
  texts: string[],
  cfg: EmbeddingConfig = loadEmbeddingConfig(),
  kind: EmbedKind = "document",
): Promise<Array<Float32Array | null> | null> {
  if (!cfg.enabled || texts.length === 0) return null;
  const input =
    kind === "query"
      ? texts.map((t) => cfg.queryPrefix + t)
      : texts.map((t) => documentText(t, cfg));
  try {
    const vectors = await requestVectors(input, cfg);
    if (!vectors || vectors.length !== texts.length) return null;
    // A missing vector is a failed batch; a poisoned one is a null slot, so the backfill can
    // still store its good neighbours instead of retrying them forever.
    return checkedUnitVectors(vectors);
  } catch {
    return null;
  }
}
