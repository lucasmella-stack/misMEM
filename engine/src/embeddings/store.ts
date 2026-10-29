/**
 * Owns the memory_embeddings SQL: saving vectors, brute-force search over them, backfill and index status.
 *
 * Capa semántica opcional sobre las memorias. Sin extensiones nativas: los vectores
 * viven como BLOB (Float32Array) en `memory_embeddings` y la búsqueda es coseno
 * brute-force en JS, pensada para una memoria personal (miles de filas, no millones)
 * sin agregar fragilidad de instalación al paquete.
 */
import type { Database as DB } from "better-sqlite3";
import { excludeNoiseSql } from "../noise.js";
import { embedTexts, loadEmbeddingConfig, type EmbedFn } from "./provider.js";
import { cosine } from "./vector.js";

const MAX_CONSECUTIVE_FAILURES = 2;

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

/** Coseno brute-force sobre todas las memorias embebidas (scope opcional). */
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
 * Embebe memories sin vector o con un modelo obsoleto (idempotente).
 * Cubre cualquier write path pendiente y permite reindexado explícito.
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

  const pendingRows = db
    .prepare(
      `SELECT m.id, m.gist, m.details, e.memory_id IS NOT NULL AS had_embedding
       FROM memories m
       LEFT JOIN memory_embeddings e ON e.memory_id = m.id
       WHERE (${opts.force ? "1 = 1" : needsEmbedding})
         AND ${excludeNoiseSql("m")}
         ${opts.scope ? "AND m.scope = @scope" : ""}`,
    )
    .all({
      scope: opts.scope,
      model,
      expectedDims: opts.expectedDims,
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
    const vecs = await embedFn(texts);
    if (!vecs) {
      // Una tanda lenta o rara no condena al resto; dos seguidas, sí: el embedder está caído.
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        stats.failed += pendingRows.length - i;
        break;
      }
      stats.failed += batch.length;
      continue;
    }
    consecutiveFailures = 0;
    for (let j = 0; j < batch.length; j++) {
      const vec = vecs[j];
      const mem = batch[j];
      if (!vec || !mem) continue;
      saveMemoryEmbedding(db, mem.id, model, vec);
      stats.embedded++;
      if (mem.had_embedding) stats.reembedded++;
    }
  }
  return stats;
}

export interface EmbeddingIndexStatus {
  memories: number;
  embedded: number;
  missing: number;
  compatible: number;
  stale_model: number;
  models: Array<{ model: string; dims: number; count: number }>;
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
  // that model produces. Without a configured width, the most common one is the best
  // guess; a tie breaks towards the smaller width so the report is deterministic.
  const dominant = db
    .prepare(
      `SELECT e.dims FROM memory_embeddings e
       JOIN memories m ON m.id = e.memory_id
       WHERE e.model = ? AND ${excludeNoiseSql("m")}
       GROUP BY e.dims ORDER BY COUNT(*) DESC, e.dims ASC LIMIT 1`,
    )
    .get(activeModel) as { dims: number } | undefined;
  const dims = expectedDims ?? dominant?.dims;
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
    stale_model: embedded - compatible,
    models,
  };
}
