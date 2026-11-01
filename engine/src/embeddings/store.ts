// Owns the memory_embeddings SQL: saving vectors, brute-force search over them, backfill and index status.
// No native extensions: vectors live as Float32Array BLOBs and the cosine runs in JS, sized for a personal
// memory (thousands of rows, not millions) without adding install fragility.
import type { Database as DB } from "better-sqlite3";
import { readMeta, writeMeta } from "../store/meta.js";
import { excludeNoiseSql } from "../store/rows.js";
import { embedTexts, loadEmbeddingConfig, type EmbedFn } from "./provider.js";
import { cosine, checkedUnitVectors } from "./vector.js";

const MAX_CONSECUTIVE_FAILURES = 2;

const activeDimsKey = (model: string): string => `embedding_dims:${model}`;

/**
 * The width the embedder last produced for this model. Ground truth over the stored majority:
 * after a provider change of width, the old vectors outnumber the new and are the stale ones.
 */
function recordedDims(db: DB, model: string): number | undefined {
  const raw = readMeta(db, activeDimsKey(model));
  const value = Number(raw);
  return raw !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function saveMemoryEmbedding(
  db: DB,
  memoryId: string,
  model: string,
  vec: Float32Array,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO memory_embeddings (memory_id, model, dims, vec, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(memoryId, model, vec.length, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), Date.now());
}

export interface SemanticHit {
  id: string;
  scope: string;
  text: string;
  salience: number;
  created_at: number;
  last_accessed_at: number | null;
  salience_updated_at: number | null;
  score: number;
}

/** Brute-force cosine over every embedded memory (optional scope). */
export function semanticSearchMemories(
  db: DB,
  queryVec: Float32Array,
  opts: {
    scope?: string;
    limit: number;
    minScore?: number;
    model?: string;
  },
): SemanticHit[] {
  const minScore = opts.minScore ?? 0.5;
  const filters = [
    opts.scope ? "m.scope = @scope" : null,
    opts.model ? "e.model = @model" : null,
    "e.dims = @dims",
    excludeNoiseSql("m"),
  ].filter((value): value is string => value !== null);
  const rows = db
    .prepare(
      `SELECT m.id, m.scope, m.gist AS text, m.salience, m.created_at,
              m.last_accessed_at, m.salience_updated_at, e.vec
       FROM memory_embeddings e JOIN memories m ON m.id = e.memory_id
       WHERE ${filters.join(" AND ")}`,
    )
    .all({
      scope: opts.scope,
      model: opts.model,
      dims: queryVec.length,
    }) as Array<{
    id: string;
    scope: string;
    text: string;
    salience: number;
    created_at: number;
    last_accessed_at: number | null;
    salience_updated_at: number | null;
    vec: Buffer;
  }>;

  const hits: SemanticHit[] = [];
  for (const r of rows) {
    const vec = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4);
    const score = cosine(queryVec, vec);
    if (score >= minScore) {
      hits.push({
        id: r.id,
        scope: r.scope,
        text: r.text,
        salience: r.salience,
        created_at: r.created_at,
        last_accessed_at: r.last_accessed_at,
        salience_updated_at: r.salience_updated_at,
        score,
      });
    }
  }
  hits.sort((a, b) => b.score - a.score || b.salience - a.salience);
  return hits.slice(0, opts.limit);
}

export interface BackfillStats {
  pending: number;
  embedded: number;
  reembedded: number;
  failed: number;
}

/**
 * True when a stored BLOB can still score: every component is finite and the norm is not zero.
 * Rows written before validation existed can carry NaN, and `hasComparableVectors` ignores
 * their content, so they would keep the lexical rescue off while matching nothing.
 */
function isValidStoredVector(vec: Buffer): boolean {
  const values = new Float32Array(vec.buffer, vec.byteOffset, vec.byteLength / 4);
  let squares = 0;
  for (let i = 0; i < values.length; i++) {
    const value = values[i] ?? 0;
    if (!Number.isFinite(value)) return false;
    squares += value * value;
  }
  return Number.isFinite(squares) && squares > 0;
}

/** Ids of the active model's rows that a previous version stored unusable. */
function invalidEmbeddingIds(db: DB, model: string): string[] {
  // Noise markers never reach the backfill, so counting their rows would keep `--status`
  // reporting an invalid vector that nothing can cure.
  const rows = db
    .prepare(
      `SELECT e.memory_id, e.vec
       FROM memory_embeddings e JOIN memories m ON m.id = e.memory_id
       WHERE e.model = ? AND ${excludeNoiseSql("m")}`,
    )
    .all(model) as Array<{ memory_id: string; vec: Buffer }>;
  return rows.filter((row) => !isValidStoredVector(row.vec)).map((row) => row.memory_id);
}

/**
 * Embeds memories without a vector or with a stale model (idempotent).
 * Covers any pending write path and allows an explicit reindex.
 */
export async function embedPendingMemories(
  db: DB,
  opts: {
    scope?: string;
    batchSize?: number;
    embedFn?: EmbedFn;
    model?: string;
    timeoutMs?: number;
    expectedDims?: number;
    force?: boolean;
  } = {},
): Promise<BackfillStats> {
  const cfg = loadEmbeddingConfig();
  if (!cfg.enabled && !opts.embedFn) {
    return { pending: 0, embedded: 0, reembedded: 0, failed: 0 };
  }
  const embedFn =
    opts.embedFn ??
    ((texts: string[]) => embedTexts(texts, { ...cfg, timeoutMs: opts.timeoutMs ?? cfg.timeoutMs }));
  const model = opts.model ?? cfg.model;
  const batchSize = opts.batchSize ?? 32;
  const maxChars = cfg.maxChars;
  const needsEmbedding = [
    "e.memory_id IS NULL",
    "e.model <> @model",
    opts.expectedDims !== undefined ? "e.dims <> @expectedDims" : null,
  ]
    .filter((value): value is string => value !== null)
    .join(" OR ");

  // Rows the previous version saved with NaN or a zero norm stay "compatible" for the SQL
  // filter, so they are collected here and treated as pending. Only the backfill pays for
  // walking these BLOBs; the recall path never does.
  const invalidIds = opts.force ? [] : invalidEmbeddingIds(db, model);
  const pendingRows = db
    .prepare(
      `SELECT m.id, m.gist, m.details, e.memory_id IS NOT NULL AS had_embedding
       FROM memories m
       LEFT JOIN memory_embeddings e ON e.memory_id = m.id
       WHERE (${
         opts.force
           ? "1 = 1"
           : `(${needsEmbedding} OR m.id IN (SELECT value FROM json_each(@invalidIds)))`
       })
         AND ${excludeNoiseSql("m")}
         ${opts.scope ? "AND m.scope = @scope" : ""}`,
    )
    .all({
      scope: opts.scope,
      model,
      expectedDims: opts.expectedDims,
      invalidIds: JSON.stringify(invalidIds),
    }) as Array<{
    id: string;
    gist: string;
    details: string | null;
    had_embedding: number;
  }>;

  const stats: BackfillStats = {
    pending: pendingRows.length,
    embedded: 0,
    reembedded: 0,
    failed: 0,
  };

  let consecutiveFailures = 0;
  for (let i = 0; i < pendingRows.length; i += batchSize) {
    const batch = pendingRows.slice(i, i + batchSize);
    const texts = batch.map((m) =>
      (m.details ? `${m.gist}\n${m.details}` : m.gist).slice(0, maxChars),
    );
    const raw = await embedFn(texts);
    // An injected embedFn reaches this point without going through `embedTexts`, so the
    // vectors are validated here too. A short response is a failed batch; inside a batch
    // with the right shape, each bad vector is counted alone and its neighbours are saved.
    const vecs = raw && raw.length === batch.length ? checkedUnitVectors(raw) : null;
    // A batch whose vectors are all unusable is as dead as a null response. Without this the
    // guard never trips and a broken embedder walks the whole backlog; each memory still
    // counts as failed once.
    if (!vecs || vecs.every((vec) => vec === null)) {
      // A slow or odd batch does not doom the rest; two in a row do: the embedder is down.
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        stats.failed += pendingRows.length - i;
        break;
      }
      stats.failed += batch.length;
      continue;
    }
    consecutiveFailures = 0;
    let savedDims: number | undefined;
    for (let j = 0; j < batch.length; j++) {
      const vec = vecs[j];
      const mem = batch[j];
      if (!mem) continue;
      if (!vec) {
        stats.failed++;
        continue;
      }
      saveMemoryEmbedding(db, mem.id, model, vec);
      savedDims = vec.length;
      stats.embedded++;
      if (mem.had_embedding) stats.reembedded++;
    }
    // The status reads this instead of guessing from the majority, which lags a width change.
    if (savedDims !== undefined) writeMeta(db, activeDimsKey(model), String(savedDims));
  }
  return stats;
}

export interface EmbeddingIndexStatus {
  memories: number;
  embedded: number;
  missing: number;
  compatible: number;
  stale_model: number;
  stale_dims: number;
  /** Active-model rows a previous version stored with a non-finite component or a zero norm. */
  invalid: number;
  models: Array<{ model: string; dims: number; count: number }>;
  /** The width search compares against: nullable because an unindexed base has none. */
  active_dims: number | null;
}

export function getEmbeddingIndexStatus(
  db: DB,
  activeModel: string,
  expectedDims?: number,
): EmbeddingIndexStatus {
  // Noise markers never get a vector on purpose, so counting them as missing would make
  // a healthy index look forever broken.
  const memories = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM memories m WHERE ${excludeNoiseSql("m")}`)
      .get() as { n: number }
  ).n;
  const embedded = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM memory_embeddings e
         JOIN memories m ON m.id = e.memory_id
         WHERE ${excludeNoiseSql("m")}`,
      )
      .get() as { n: number }
  ).n;
  // A vector is only usable by search when it has both the active model and the width
  // that model produces. The recorded width wins; the stored majority only fills in for a
  // base indexed before the width was recorded. A tie breaks towards the smaller width.
  const dominant = db
    .prepare(
      `SELECT e.dims FROM memory_embeddings e
       JOIN memories m ON m.id = e.memory_id
       WHERE e.model = ? AND ${excludeNoiseSql("m")}
       GROUP BY e.dims ORDER BY COUNT(*) DESC, e.dims ASC LIMIT 1`,
    )
    .get(activeModel) as { dims: number } | undefined;
  const dims = expectedDims ?? recordedDims(db, activeModel) ?? dominant?.dims;
  const compatible =
    dims === undefined
      ? 0
      : (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM memory_embeddings e
               JOIN memories m ON m.id = e.memory_id
               WHERE e.model = ? AND e.dims = ? AND ${excludeNoiseSql("m")}`,
            )
            .get(activeModel, dims) as { n: number }
        ).n;
  // The active model can come back with a different width after a provider upgrade. Those
  // vectors are not "another model": they need a forced reindex, not an incremental one.
  const stale_dims =
    dims === undefined
      ? 0
      : (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM memory_embeddings e
               JOIN memories m ON m.id = e.memory_id
               WHERE e.model = ? AND e.dims <> ? AND ${excludeNoiseSql("m")}`,
            )
            .get(activeModel, dims) as { n: number }
        ).n;
  const models = db
    .prepare(
      `SELECT e.model, e.dims, COUNT(*) AS count FROM memory_embeddings e
       JOIN memories m ON m.id = e.memory_id
       WHERE ${excludeNoiseSql("m")}
       GROUP BY e.model, e.dims
       ORDER BY count DESC, e.model, e.dims`,
    )
    .all() as Array<{ model: string; dims: number; count: number }>;

  return {
    memories,
    embedded,
    missing: memories - embedded,
    compatible,
    stale_model: embedded - compatible - stale_dims,
    stale_dims,
    active_dims: dims ?? null,
    invalid: invalidEmbeddingIds(db, activeModel).length,
    models,
  };
}
