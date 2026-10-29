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
  /** Traits and pending episodes share the same run, reported apart. */
  layers: { pending: number; embedded: number; failed: number };
}

export type LayerName = "trait" | "episode";

interface BatchRow {
  /** Non-zero when the item already had a vector, so the stats can count reindexes. */
  had_embedding: number;
}

/**
 * One batching loop for every layer: a batch that fails does not condemn the rest, two in
 * a row mean the embedder is down. Memories and layer items share it so a fix to the
 * failure policy cannot drift between them.
 */
async function embedInBatches<T extends BatchRow>(
  rows: readonly T[],
  embedFn: EmbedFn,
  batchSize: number,
  textOf: (row: T) => string,
  save: (row: T, vec: Float32Array) => void,
): Promise<{ embedded: number; reembedded: number; failed: number }> {
  const stats = { embedded: 0, reembedded: 0, failed: 0 };
  let consecutiveFailures = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const vecs = await embedFn(batch.map(textOf));
    if (!vecs) {
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
      const vec = vecs[j];
      const row = batch[j];
      if (!vec || !row) continue;
      save(row, vec);
      stats.embedded++;
      if (row.had_embedding) stats.reembedded++;
    }
  }
  return stats;
}

/**
 * Embeds memories, traits and pending episodes that have no vector or an outdated model
 * (idempotent). It covers any pending write path and allows an explicit reindex.
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
      model: resolved.model,
      expectedDims: opts.expectedDims,
    }) as Array<{
    id: string;
    gist: string;
    details: string | null;
    had_embedding: number;
  }>;

  const memories = await embedInBatches(
    pendingRows,
    resolved.embedFn,
    resolved.batchSize,
    (m) => (m.details ? `${m.gist}\n${m.details}` : m.gist).slice(0, resolved.maxChars),
    (m, vec) => saveMemoryEmbedding(db, m.id, resolved.model, vec),
  );

  // Traits and pending episodes follow the same run: a caller that backfills memories
  // never leaves the other two layers without vectors.
  const layers = await embedPendingLayersResolved(db, resolved);

  return { pending: pendingRows.length, ...memories, layers };
}

interface ResolveOptions {
  scope?: string;
  batchSize?: number;
  embedFn?: EmbedFn;
  model?: string;
  timeoutMs?: number;
  expectedDims?: number;
  force?: boolean;
}

interface ResolvedEmbedOptions {
  embedFn: EmbedFn;
  model: string;
  batchSize: number;
  maxChars: number;
  scope?: string;
  expectedDims?: number;
  force?: boolean;
}

function resolveEmbedOptions(
  opts: ResolveOptions,
  cfg: ReturnType<typeof loadEmbeddingConfig>,
): ResolvedEmbedOptions {
  return {
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

async function embedPendingLayersResolved(
  db: DB,
  opts: ResolvedEmbedOptions,
): Promise<{ pending: number; embedded: number; failed: number }> {
  const needsEmbedding = [
    "e.item_id IS NULL",
    "e.model <> @model",
    opts.expectedDims !== undefined ? "e.dims <> @expectedDims" : null,
  ]
    .filter((value): value is string => value !== null)
    .join(" OR ");
  const predicate = opts.force ? "1 = 1" : needsEmbedding;
  const params = {
    model: opts.model,
    expectedDims: opts.expectedDims,
    scope: opts.scope,
  };

  const traitRows = db
    .prepare(
      `SELECT t.id, t.name AS text, e.item_id IS NOT NULL AS had_embedding
       FROM traits t
       LEFT JOIN layer_embeddings e ON e.layer = 'trait' AND e.item_id = t.id
       WHERE (${predicate}) ${opts.scope ? "AND t.scope = @scope" : ""}`,
    )
    .all(params) as Array<{ id: string; text: string; had_embedding: number }>;
  const episodeRows = db
    .prepare(
      `SELECT ep.id, ep.body AS text, e.item_id IS NOT NULL AS had_embedding
       FROM episodes ep
       LEFT JOIN layer_embeddings e ON e.layer = 'episode' AND e.item_id = ep.id
       WHERE ep.consolidated_into IS NULL
         AND (${predicate}) ${opts.scope ? "AND ep.scope = @scope" : ""}`,
    )
    .all(params) as Array<{ id: string; text: string; had_embedding: number }>;

  const stats: { pending: number; embedded: number; failed: number } = {
    pending: traitRows.length + episodeRows.length,
    embedded: 0,
    failed: 0,
  };
  const layers = [
    { layer: "trait" as const, rows: traitRows },
    { layer: "episode" as const, rows: episodeRows },
  ];
  for (const { layer, rows } of layers) {
    const batch = await embedInBatches(
      rows,
      opts.embedFn,
      opts.batchSize,
      (row) => row.text.slice(0, opts.maxChars),
      (row, vec) => saveLayerEmbedding(db, layer, row.id, opts.model, vec),
    );
    stats.embedded += batch.embedded;
    stats.failed += batch.failed;
  }
  return stats;
}

export function saveLayerEmbedding(
  db: DB,
  layer: LayerName,
  itemId: string,
  model: string,
  vec: Float32Array,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO layer_embeddings (layer, item_id, model, dims, vec, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    layer,
    itemId,
    model,
    vec.length,
    Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength),
    Date.now(),
  );
}

/**
 * Embeds one freshly written trait or episode, best effort. `capture` and `crystallize`
 * go through here so the item is searchable by meaning at once; a dead embedder returns
 * false and the next backfill picks it up, never breaking the write.
 */
export async function embedLayerItem(
  db: DB,
  layer: LayerName,
  itemId: string,
  opts: { embedFn?: EmbedFn; model?: string; timeoutMs?: number } = {},
): Promise<boolean> {
  const cfg = loadEmbeddingConfig();
  if (!cfg.enabled && !opts.embedFn) return false;
  const row =
    layer === "trait"
      ? (db.prepare("SELECT name AS text FROM traits WHERE id = ?").get(itemId) as
          | { text: string }
          | undefined)
      : (db
          .prepare("SELECT body AS text FROM episodes WHERE id = ? AND consolidated_into IS NULL")
          .get(itemId) as { text: string } | undefined);
  if (!row) return false;

  const embedFn =
    opts.embedFn ??
    ((texts: string[]) =>
      embedTexts(texts, { ...cfg, timeoutMs: opts.timeoutMs ?? cfg.timeoutMs }));
  const vecs = await embedFn([row.text.slice(0, cfg.maxChars)]);
  const vec = vecs?.[0];
  if (!vec) return false;
  saveLayerEmbedding(db, layer, itemId, opts.model ?? cfg.model, vec);
  return true;
}

export interface LayerSemanticHit {
  id: string;
  scope: string;
  text: string;
  created_at: number;
  score: number;
}

/**
 * Brute-force cosine over the stored vectors of one layer. Pending episodes are filtered
 * by `consolidated_into IS NULL`: the trigger removes their vector on consolidation, but
 * a DB restored from an older backup may still carry one and it must not compete.
 */
export function semanticSearchLayer(
  db: DB,
  layer: LayerName,
  queryVec: Float32Array,
  opts: { scope?: string; limit: number; minScore?: number; model?: string },
): LayerSemanticHit[] {
  const minScore = opts.minScore ?? 0.5;
  const scopeColumn = layer === "trait" ? "t.scope" : "ep.scope";
  const filters = [
    opts.scope ? `${scopeColumn} = @scope` : null,
    opts.model ? "e.model = @model" : null,
    "e.dims = @dims",
  ].filter((value): value is string => value !== null);
  const source =
    layer === "trait"
      ? `SELECT t.id, t.scope, t.name AS text, t.created_at, e.vec
         FROM layer_embeddings e JOIN traits t ON t.id = e.item_id
         WHERE e.layer = 'trait'`
      : `SELECT ep.id, ep.scope, ep.body AS text, ep.created_at, e.vec
         FROM layer_embeddings e JOIN episodes ep ON ep.id = e.item_id
         WHERE e.layer = 'episode' AND ep.consolidated_into IS NULL`;
  const rows = db
    .prepare(`${source} AND ${filters.join(" AND ")}`)
    .all({ scope: opts.scope, model: opts.model, dims: queryVec.length }) as Array<{
    id: string;
    scope: string;
    text: string;
    created_at: number;
    vec: Buffer;
  }>;

  const hits: LayerSemanticHit[] = [];
  for (const row of rows) {
    const vec = new Float32Array(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength / 4);
    const score = cosine(queryVec, vec);
    if (score >= minScore) {
      hits.push({
        id: row.id,
        scope: row.scope,
        text: row.text,
        created_at: row.created_at,
        score,
      });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return hits.slice(0, opts.limit);
}

/** True when some trait or pending episode has a vector this query can compare against. */
export function hasComparableLayerVectors(
  db: DB,
  opts: { model?: string; dims: number; scope?: string },
): boolean {
  const params = { scope: opts.scope, model: opts.model, dims: opts.dims };
  const filters = [
    opts.model ? "e.model = @model" : null,
    "e.dims = @dims",
  ].filter((value): value is string => value !== null);
  const trait = db
    .prepare(
      `SELECT 1 FROM layer_embeddings e JOIN traits t ON t.id = e.item_id
       WHERE e.layer = 'trait' AND ${filters.join(" AND ")}
         ${opts.scope ? "AND t.scope = @scope" : ""} LIMIT 1`,
    )
    .get(params);
  if (trait !== undefined) return true;
  return (
    db
      .prepare(
        `SELECT 1 FROM layer_embeddings e JOIN episodes ep ON ep.id = e.item_id
         WHERE e.layer = 'episode' AND ep.consolidated_into IS NULL
           AND ${filters.join(" AND ")} ${opts.scope ? "AND ep.scope = @scope" : ""} LIMIT 1`,
      )
      .get(params) !== undefined
  );
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
): EmbeddingIndexStatus {
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
  const models = db
    .prepare(
      `SELECT model, dims, COUNT(*) AS count
       FROM memory_embeddings
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
    models,
  };
}
