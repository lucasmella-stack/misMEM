/**
 * Capa semántica opcional sobre las memorias.
 *
 * Diseño: sin extensiones nativas. Los vectores viven como BLOB (Float32Array)
 * en `memory_embeddings` y la búsqueda es coseno brute-force en JS — pensada
 * para una memoria personal (miles de filas, no millones) sin agregar
 * fragilidad de instalación al paquete.
 *
 * Embeddings via Ollama local (default: nomic-embed-text). Si Ollama no está
 * corriendo, todo degrada silenciosamente a FTS5 puro.
 */
import type { Database as DB } from "better-sqlite3";

export interface EmbeddingConfig {
  enabled: boolean;
  url: string;
  model: string;
  timeoutMs: number;
}

export function loadEmbeddingConfig(): EmbeddingConfig {
  return {
    enabled: (process.env.MISMEM_EMBEDDINGS ?? "auto") !== "off",
    url: process.env.MISMEM_OLLAMA_URL ?? "http://127.0.0.1:11434",
    model: process.env.MISMEM_EMBEDDING_MODEL ?? "nomic-embed-text",
    timeoutMs: Number(process.env.MISMEM_EMBEDDING_TIMEOUT_MS) || 3000,
  };
}

export type EmbedFn = (texts: string[]) => Promise<Float32Array[] | null>;

/** Llama a Ollama /api/embed. Devuelve null ante cualquier fallo (sin throw). */
export async function embedTexts(
  texts: string[],
  cfg: EmbeddingConfig = loadEmbeddingConfig(),
): Promise<Float32Array[] | null> {
  if (!cfg.enabled || texts.length === 0) return null;
  try {
    const res = await fetch(`${cfg.url}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: cfg.model, input: texts }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { embeddings?: number[][] };
    if (!data.embeddings || data.embeddings.length !== texts.length) return null;
    return data.embeddings.map((e) => Float32Array.from(e));
  } catch {
    return null;
  }
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

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return -1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? -1 : dot / denom;
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
  hits.sort((a, b) => b.score - a.score);
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

  for (let i = 0; i < pendingRows.length; i += batchSize) {
    const batch = pendingRows.slice(i, i + batchSize);
    const texts = batch.map((m) => (m.details ? `${m.gist}\n${m.details}` : m.gist));
    const vecs = await embedFn(texts);
    if (!vecs) {
      // Embedder caído: cortar acá — el resto fallaría igual y solo sumaría timeouts.
      stats.failed += pendingRows.length - i;
      break;
    }
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
