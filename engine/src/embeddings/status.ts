// What the semantic index looks like from outside: how much is embedded, how much went stale
// and why. Split from store.ts, which owns writing and searching, so neither grows past its
// ratchet; the two staleness tests are different questions and both are needed.
import type { Database as DB } from "better-sqlite3";
import { excludeNoiseSql } from "../store/rows.js";
import { layerIndexStatus, type LayerIndexStatus } from "./layers.js";
import { loadEmbeddingConfig, type EmbeddingConfig } from "./provider.js";
import {
  invalidEmbeddingIds,
  recordedDims,
  registerFingerprintFunctions,
} from "./store.js";


export interface EmbeddingIndexStatus {
  memories: number;
  embedded: number;
  missing: number;
  compatible: number;
  stale_model: number;
  /** Rows of the active model whose vector no longer matches their text or the config. */
  outdated: number;
  stale_dims: number;
  layers: { trait: LayerIndexStatus; episode: LayerIndexStatus };
  /** Active-model rows a previous version stored with a non-finite component or a zero norm. */
  invalid: number;
  models: Array<{ model: string; dims: number; count: number }>;
  /** The width search compares against: nullable because an unindexed base has none. */
  active_dims: number | null;
}

export function getEmbeddingIndexStatus(
  db: DB,
  activeModel: string,
  cfg: EmbeddingConfig = loadEmbeddingConfig(),
  expectedDims?: number,
): EmbeddingIndexStatus {
  registerFingerprintFunctions(db, cfg);
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
      // Both tables, and on the memory side without the noise markers: they do not compete
      // in recall, so they do not count as index either.
      `SELECT model, dims, SUM(count) AS count FROM (
         SELECT e.model AS model, e.dims AS dims, COUNT(*) AS count FROM memory_embeddings e
           JOIN memories m ON m.id = e.memory_id
           WHERE ${excludeNoiseSql("m")}
           GROUP BY e.model, e.dims
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
    stale_model: embedded - compatible - stale_dims,
    stale_dims,
    active_dims: dims ?? null,
    outdated,
    layers: {
      trait: layerIndexStatus(db, "trait", activeModel),
      episode: layerIndexStatus(db, "episode", activeModel),
    },
    invalid: invalidEmbeddingIds(db, activeModel).length,
    models,
  };
}
