// Owns the memory_embeddings SQL: saving vectors, brute-force search over them, backfill and
// index status. The vectors of traits and pending episodes live in `layers.ts`.
import type { Database as DB } from "better-sqlite3";
import { excludeNoiseSql } from "../store/rows.js";
import {
  embedInBatches,
  resolveEmbedOptions,
  type ResolveOptions,
} from "./batch.js";
import {
  embedPendingLayersResolved,
  layerIndexStatus,
  type LayerIndexStatus,
} from "./layers.js";
import {
  embeddingFingerprint,
  loadEmbeddingConfig,
  type EmbeddingConfig,
} from "./provider.js";
import { cosine } from "./vector.js";

/**
 * Automatic backfills (the consolidate tool, a viewer edit, the nightly run) can fire while a
 * client waits, so they embed at most this many rows per call and leave the rest for the next
 * pass. `mismem-embed` passes no cap: there the wait is the job and the progress is visible.
 */
export const AUTO_BACKFILL_MAX_ROWS = 64;

/** Stored text of a memory as the backfill embeds it. */
function memoryEmbeddingText(row: { gist: string; details: string | null }): string {
  return row.details ? `${row.gist}\n${row.details}` : row.gist;
}

/**
 * SQLite cannot hash, so the pending queries and the status call back into these functions.
 * Deterministic and built from the config of this call, which is what turns "the vector no
 * longer describes its row" into a plain SQL predicate.
 */
function registerFingerprintFunctions(db: DB, cfg: EmbeddingConfig): void {
  db.function("mismem_fp_text", { deterministic: true }, (text: string) =>
    embeddingFingerprint(text, cfg),
  );
  db.function("mismem_fp_memory", { deterministic: true }, (gist: string, details: string | null) =>
    embeddingFingerprint(memoryEmbeddingText({ gist, details }), cfg),
  );
}

/**
 * `text` is the untruncated text the caller embedded; the fingerprint truncates it the same
 * way the request does. Omitted (fixtures, callers that just saved the row), the row's
 * current text is read, which is the same string they were embedding.
 */
export function saveMemoryEmbedding(
  db: DB,
  memoryId: string,
  model: string,
  vec: Float32Array,
  text?: string,
  cfg: EmbeddingConfig = loadEmbeddingConfig(),
): void {
  const source = text ?? currentMemoryText(db, memoryId);
  const fingerprint = embeddingFingerprint(source, cfg);
  db.prepare(
    `INSERT OR REPLACE INTO memory_embeddings (memory_id, model, dims, vec, created_at, fingerprint)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    memoryId,
    model,
    vec.length,
    Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength),
    Date.now(),
    fingerprint,
  );
}

function currentMemoryText(db: DB, memoryId: string): string {
  const row = db.prepare("SELECT gist, details FROM memories WHERE id = ?").get(memoryId) as
    | { gist: string; details: string | null }
    | undefined;
  if (!row) throw new Error(`no existe la memoria: ${memoryId}`);
  return memoryEmbeddingText(row);
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
  /** Traits and pending episodes share the same run, reported apart. */
  layers: { pending: number; embedded: number; failed: number };
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
 * Embeds memories, traits and pending episodes that have no vector, an outdated model or a
 * fingerprint that no longer matches their text and the current config (idempotent). It
 * covers any pending write path and allows an explicit reindex.
 */
export async function embedPendingMemories(
  db: DB,
  opts: ResolveOptions = {},
): Promise<BackfillStats> {
  const cfg = loadEmbeddingConfig();
  if (!cfg.enabled && !opts.embedFn) {
    return {
      pending: 0,
      embedded: 0,
      reembedded: 0,
      failed: 0,
      layers: { pending: 0, embedded: 0, failed: 0 },
    };
  }
  const resolved = resolveEmbedOptions(opts, cfg);
  registerFingerprintFunctions(db, cfg);
  const needsEmbedding = [
    "e.memory_id IS NULL",
    "e.model <> @model",
    opts.expectedDims !== undefined ? "e.dims <> @expectedDims" : null,
    "COALESCE(e.fingerprint, '') <> mismem_fp_memory(m.gist, m.details)",
  ]
    .filter((value): value is string => value !== null)
    .join(" OR ");

  // Rows the previous version saved with NaN or a zero norm stay "compatible" for the SQL
  // filter, so they are collected here and treated as pending. Only the backfill pays for
  // walking these BLOBs; the recall path never does.
  const invalidIds = opts.force ? [] : invalidEmbeddingIds(db, resolved.model);
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
      model: resolved.model,
      expectedDims: opts.expectedDims,
      invalidIds: JSON.stringify(invalidIds),
    }) as Array<{
    id: string;
    gist: string;
    details: string | null;
    had_embedding: number;
  }>;

  // A bounded caller embeds at most `maxRows` rows across the three layers; `pending` keeps
  // reporting the whole backlog so the rest is visibly waiting for the next pass.
  const budget = opts.maxRows ?? Number.POSITIVE_INFINITY;
  const selectedRows = pendingRows.slice(0, budget);
  const memories = await embedInBatches(
    selectedRows,
    resolved.embedFn,
    resolved.batchSize,
    (m) => (m.details ? `${m.gist}\n${m.details}` : m.gist).slice(0, resolved.maxChars),
    (m, vec) => {
      saveMemoryEmbedding(db, m.id, resolved.model, vec, memoryEmbeddingText(m), resolved.cfg);
      return true;
    },
  );

  // Traits and pending episodes follow the same run: a caller that backfills memories
  // never leaves the other two layers without vectors.
  const layers = await embedPendingLayersResolved(db, resolved, budget - selectedRows.length);
  return { pending: pendingRows.length, ...memories, layers };
}

export interface EmbeddingIndexStatus {
  memories: number;
  embedded: number;
  missing: number;
  compatible: number;
  stale_model: number;
  /** Rows of the active model whose vector no longer matches their text or the config. */
  outdated: number;
  layers: { trait: LayerIndexStatus; episode: LayerIndexStatus };
  /** Active-model rows a previous version stored with a non-finite component or a zero norm. */
  invalid: number;
  models: Array<{ model: string; dims: number; count: number }>;
}

export function getEmbeddingIndexStatus(
  db: DB,
  activeModel: string,
  cfg: EmbeddingConfig = loadEmbeddingConfig(),
): EmbeddingIndexStatus {
  registerFingerprintFunctions(db, cfg);
  const memories = (
    db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }
  ).n;
  const embedded = (
    db.prepare("SELECT COUNT(*) AS n FROM memory_embeddings").get() as {
      n: number;
    }
  ).n;
  const compatible = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM memory_embeddings WHERE model = ?",
      )
      .get(activeModel) as { n: number }
  ).n;
  const outdated = (
    db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM memory_embeddings e JOIN memories m ON m.id = e.memory_id
         WHERE e.model = @model
           AND ${excludeNoiseSql("m")}
           AND COALESCE(e.fingerprint, '') <> mismem_fp_memory(m.gist, m.details)`,
      )
      .get({ model: activeModel }) as { n: number }
  ).n;
  const models = db
    .prepare(
      `SELECT model, dims, SUM(count) AS count FROM (
         SELECT model, dims, COUNT(*) AS count FROM memory_embeddings GROUP BY model, dims
         UNION ALL
         SELECT model, dims, COUNT(*) AS count FROM layer_embeddings GROUP BY model, dims
       )
       GROUP BY model, dims
       ORDER BY count DESC, model, dims`,
    )
    .all() as Array<{ model: string; dims: number; count: number }>;

  return {
    memories,
    embedded,
    missing: memories - embedded,
    compatible,
    stale_model: embedded - compatible,
    outdated,
    layers: {
      trait: layerIndexStatus(db, "trait", activeModel),
      episode: layerIndexStatus(db, "episode", activeModel),
    },
    invalid: invalidEmbeddingIds(db, activeModel).length,
    models,
  };
}
