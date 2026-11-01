// Owns the layer_embeddings SQL: the vectors of traits and pending episodes, their
// backfill, the best-effort write of a fresh item, brute-force search over them and their
// index status. Memories keep their own table and code path in `store.ts`.
import type { Database as DB } from "better-sqlite3";
import { embedInBatches, type BatchRow, type ResolvedEmbedOptions } from "./batch.js";
import {
  embedTexts,
  embeddingFingerprint,
  loadEmbeddingConfig,
  type EmbeddingConfig,
  type EmbedFn,
} from "./provider.js";
import { checkedUnitVectors, cosine } from "./vector.js";

export type LayerName = "trait" | "episode";

export function saveLayerEmbedding(
  db: DB,
  layer: LayerName,
  itemId: string,
  model: string,
  vec: Float32Array,
  text?: string,
  cfg: EmbeddingConfig = loadEmbeddingConfig(),
): void {
  const source = text ?? liveLayerText(db, layer, itemId);
  if (source === undefined) throw new Error(`no existe el elemento de la capa ${layer}: ${itemId}`);
  db.prepare(
    `INSERT OR REPLACE INTO layer_embeddings (layer, item_id, model, dims, vec, created_at, fingerprint)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    layer,
    itemId,
    model,
    vec.length,
    Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength),
    Date.now(),
    embeddingFingerprint(source, cfg),
  );
}

/** Text of a live layer item, or undefined when it no longer exists or is consolidated. */
function liveLayerText(db: DB, layer: LayerName, itemId: string): string | undefined {
  const row =
    layer === "trait"
      ? db.prepare("SELECT name AS text FROM traits WHERE id = ?").get(itemId)
      : db
          .prepare("SELECT body AS text FROM episodes WHERE id = ? AND consolidated_into IS NULL")
          .get(itemId);
  return (row as { text: string } | undefined)?.text;
}

/**
 * The embedder answers asynchronously, so the item can be renamed, consolidated or deleted
 * meanwhile. The live text is checked in the same transaction as the save: a vector for
 * text that no longer exists would match the wrong thing until the next force backfill.
 */
function saveLayerEmbeddingIfCurrent(
  db: DB,
  layer: LayerName,
  itemId: string,
  expectedText: string,
  model: string,
  vec: Float32Array,
  cfg: EmbeddingConfig,
): boolean {
  return db.transaction(() => {
    if (liveLayerText(db, layer, itemId) !== expectedText) return false;
    saveLayerEmbedding(db, layer, itemId, model, vec, expectedText, cfg);
    return true;
  })();
}

// The write path already committed the item; this cap only bounds how long the caller waits
// for its vector. The backfill runs without it because there the wait is the job.
const WRITE_EMBED_TIMEOUT_MS = 1_000;

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

  const timeoutMs = opts.timeoutMs ?? Math.min(cfg.timeoutMs, WRITE_EMBED_TIMEOUT_MS);
  const embedFn =
    opts.embedFn ?? ((texts: string[]) => embedTexts(texts, { ...cfg, timeoutMs }));
  // An injected embedFn does not go through `embedTexts`, so the same check the backfill
  // applies is applied here: a non-finite or zero vector is never stored.
  const vec = checkedUnitVectors((await embedFn([row.text.slice(0, cfg.maxChars)])) ?? [])?.[0];
  if (!vec) return false;
  const model = opts.model ?? cfg.model;

  // The item can be renamed, consolidated or deleted while the embedder responds. The
  // helper checks and saves in one transaction so a stale vector cannot outlive its text.
  return saveLayerEmbeddingIfCurrent(db, layer, itemId, row.text, model, vec, cfg);
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

export interface LayerIndexStatus {
  items: number;
  embedded: number;
  missing: number;
  compatible: number;
  stale_model: number;
  /** Rows of the active model whose vector no longer matches their text or the config. */
  outdated: number;
}

export function layerIndexStatus(
  db: DB,
  layer: LayerName,
  activeModel: string,
): LayerIndexStatus {
  const source =
    layer === "trait"
      ? `FROM traits t
         LEFT JOIN layer_embeddings e ON e.layer = 'trait' AND e.item_id = t.id`
      : `FROM episodes ep
         LEFT JOIN layer_embeddings e ON e.layer = 'episode' AND e.item_id = ep.id
         WHERE ep.consolidated_into IS NULL`;
  const text = layer === "trait" ? "t.name" : "ep.body";
  const row = db
    .prepare(
      `SELECT COUNT(*) AS items,
              COALESCE(SUM(CASE WHEN e.item_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS embedded,
              COALESCE(SUM(CASE WHEN e.model = @model THEN 1 ELSE 0 END), 0) AS compatible,
              COALESCE(SUM(CASE WHEN e.model = @model
                                 AND COALESCE(e.fingerprint, '') <> mismem_fp_text(${text})
                                THEN 1 ELSE 0 END), 0) AS outdated
       ${source}`,
    )
    .get({ model: activeModel }) as {
    items: number;
    embedded: number;
    compatible: number;
    outdated: number;
  };
  return {
    items: row.items,
    embedded: row.embedded,
    missing: row.items - row.embedded,
    compatible: row.compatible,
    stale_model: row.embedded - row.compatible,
    outdated: row.outdated,
  };
}

interface PendingLayerRow extends BatchRow {
  id: string;
  text: string;
}

export interface PendingLayerRows {
  traits: PendingLayerRow[];
  episodes: PendingLayerRow[];
}

/**
 * Reads the traits and pending episodes without a vector or with a stale model, without
 * embedding anything. The memory backfill calls this before spending its cap so it can
 * reserve room for them; embedding the rows is the second step.
 */
export function pendingLayerRows(db: DB, opts: ResolvedEmbedOptions): PendingLayerRows {
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
  // The text column differs per layer, so the hash comparison goes into each query.
  const staleTrait = `${predicate} OR COALESCE(e.fingerprint, '') <> mismem_fp_text(t.name)`;
  const staleEpisode = `${predicate} OR COALESCE(e.fingerprint, '') <> mismem_fp_text(ep.body)`;

  const pendingTraits = db
    .prepare(
      `SELECT t.id, t.name AS text, e.item_id IS NOT NULL AS had_embedding
       FROM traits t
       LEFT JOIN layer_embeddings e ON e.layer = 'trait' AND e.item_id = t.id
       WHERE (${staleTrait}) ${opts.scope ? "AND t.scope = @scope" : ""}`,
    )
    .all(params) as PendingLayerRow[];
  const pendingEpisodes = db
    .prepare(
      `SELECT ep.id, ep.body AS text, e.item_id IS NOT NULL AS had_embedding
       FROM episodes ep
       LEFT JOIN layer_embeddings e ON e.layer = 'episode' AND e.item_id = ep.id
       WHERE ep.consolidated_into IS NULL
         AND (${staleEpisode}) ${opts.scope ? "AND ep.scope = @scope" : ""}`,
    )
    .all(params) as PendingLayerRow[];

  return { traits: pendingTraits, episodes: pendingEpisodes };
}

/**
 * Embeds the traits and pending episodes already read, up to `maxRows` (traits first).
 * Idempotent: the next pass picks up whatever did not fit.
 */
export async function embedLayerRowsResolved(
  db: DB,
  opts: ResolvedEmbedOptions,
  pending: PendingLayerRows,
  maxRows: number,
): Promise<{ pending: number; embedded: number; failed: number }> {
  const traitRows = pending.traits.slice(0, maxRows);
  const episodeRows = pending.episodes.slice(0, Math.max(0, maxRows - traitRows.length));
  const stats: { pending: number; embedded: number; failed: number } = {
    pending: pending.traits.length + pending.episodes.length,
    embedded: 0,
    failed: 0,
  };
  const layers: Array<{ layer: LayerName; rows: Array<{ id: string; text: string } & BatchRow> }> = [
    { layer: "trait", rows: traitRows },
    { layer: "episode", rows: episodeRows },
  ];
  for (const { layer, rows } of layers) {
    const batch = await embedInBatches(
      rows,
      opts.embedFn,
      opts.batchSize,
      (row) => row.text.slice(0, opts.maxChars),
      (row, vec) => saveLayerEmbeddingIfCurrent(db, layer, row.id, row.text, opts.model, vec, opts.cfg),
    );
    stats.embedded += batch.embedded;
    stats.failed += batch.failed;
  }
  return stats;
}
