// One batching loop and one failure policy for every backfilled layer, plus the options
// the backfill resolves once. Memories, traits and pending episodes share it so a fix to
// the policy cannot drift between them.
import {
  embedTexts,
  type EmbeddingConfig,
  type loadEmbeddingConfig,
  type EmbedFn,
} from "./provider.js";
import { checkedUnitVectors } from "./vector.js";

const MAX_CONSECUTIVE_FAILURES = 2;

export interface BatchRow {
  /** Non-zero when the item already had a vector, so the stats can count reindexes. */
  had_embedding: number;
}

export interface BatchStats {
  embedded: number;
  reembedded: number;
  failed: number;
}

export interface ResolveOptions {
  scope?: string;
  batchSize?: number;
  embedFn?: EmbedFn;
  model?: string;
  timeoutMs?: number;
  expectedDims?: number;
  force?: boolean;
  /** Rows this call may embed, shared by the three layers; omitted means everything. */
  maxRows?: number;
}

export interface ResolvedEmbedOptions {
  cfg: EmbeddingConfig;
  embedFn: EmbedFn;
  model: string;
  batchSize: number;
  maxChars: number;
  scope?: string;
  expectedDims?: number;
  force?: boolean;
}

export function resolveEmbedOptions(
  opts: ResolveOptions,
  cfg: ReturnType<typeof loadEmbeddingConfig>,
): ResolvedEmbedOptions {
  return {
    cfg,
    embedFn:
      opts.embedFn ??
      ((texts: string[]) => embedTexts(texts, { ...cfg, timeoutMs: opts.timeoutMs ?? cfg.timeoutMs })),
    model: opts.model ?? cfg.model,
    batchSize: opts.batchSize ?? 32,
    maxChars: cfg.maxChars,
    scope: opts.scope,
    expectedDims: opts.expectedDims,
    force: opts.force,
  };
}

/**
 * Embeds `rows` batch by batch. A batch that fails does not condemn the rest; two in a row
 * mean the embedder is down. The save callback returns false when the row changed while the
 * embedder worked, so nothing was stored for it.
 */
export async function embedInBatches<T extends BatchRow>(
  rows: readonly T[],
  embedFn: EmbedFn,
  batchSize: number,
  textOf: (row: T) => string,
  save: (row: T, vec: Float32Array) => boolean,
): Promise<BatchStats> {
  const stats: BatchStats = { embedded: 0, reembedded: 0, failed: 0 };
  let consecutiveFailures = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const raw = await embedFn(batch.map(textOf));
    // An injected embedFn reaches this point without going through `embedTexts`, so the
    // vectors are validated here too. A short response is a failed batch; inside a batch
    // with the right shape, each bad vector is counted alone and its neighbours are saved.
    const vecs = raw && raw.length === batch.length ? checkedUnitVectors(raw) : null;
    // A batch whose vectors are all unusable is as dead as a null response. Without this the
    // guard never trips and a broken embedder walks the whole backlog; each row still counts
    // as failed once.
    if (!vecs || vecs.every((vec) => vec === null)) {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        stats.failed += rows.length - i;
        break;
      }
      stats.failed += batch.length;
      continue;
    }
    consecutiveFailures = 0;
    for (let j = 0; j < batch.length; j++) {
      const row = batch[j];
      const vec = vecs[j];
      if (!row) continue;
      if (!vec) {
        stats.failed++;
        continue;
      }
      if (!save(row, vec)) continue;
      stats.embedded++;
      if (row.had_embedding) stats.reembedded++;
    }
  }
  return stats;
}
