import type { Database as DB } from "better-sqlite3";
import { ulid } from "ulid";
import {
  CaptureInput,
  RecallInput,
  ConsolidateInput,
  CrystallizeInput,
  ForgetInput,
  ReinforceInput,
  type RecallHit,
} from "./schema.js";
import { contentHash } from "./hash.js";
import { registerTurn } from "./connectome.js";
import { CANDIDATE_POOL_LIMIT, fuseMemories, hasComparableVectors, lexicalCandidates } from "./search.js";
import { embedTexts, loadEmbeddingConfig, type EmbedFn } from "./embeddings/provider.js";
import { semanticSearchMemories } from "./embeddings/store.js";
import { checkedUnitVectors } from "./embeddings/vector.js";
import {
  decayMemories,
  effectiveSalience,
  reinforceMemories,
  type SalienceRow,
} from "./salience.js";

const now = (): number => Date.now();

export function capture(db: DB, raw: unknown): { id: string; deduped: boolean } {
  const input = CaptureInput.parse(raw);
  const hash = contentHash(input.body);

  // Idéntico (scope, body) ya inscripto → no duplicar; re-ingestar es idempotente.
  const existing = db
    .prepare(
      "SELECT id FROM episodes WHERE scope = ? AND content_hash = ? LIMIT 1",
    )
    .get(input.scope, hash) as { id: string } | undefined;
  if (existing) return { id: existing.id, deduped: true };

  const id = ulid();
  db.prepare(
    "INSERT INTO episodes (id, scope, body, created_at, content_hash) VALUES (?, ?, ?, ?, ?)",
  ).run(id, input.scope, input.body, now(), hash);
  return { id, deduped: false };
}

export interface PendingEpisode {
  id: string;
  scope: string;
  text: string;
  created_at: number;
  consolidated_into: string | null;
}

// The viewer's pending list and engram mem_context must agree on what "pending" and
// "newest first" mean, so both read through these two.
const PENDING_WHERE = "consolidated_into IS NULL AND (@scope IS NULL OR scope = @scope)";

export function countPendingEpisodes(db: DB, scope: string | null): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM episodes WHERE ${PENDING_WHERE}`).get({ scope }) as { n: number }
  ).n;
}

/** Unconsolidated episodes, newest first; rowid breaks ties between the same millisecond. */
export function pendingEpisodes(db: DB, scope: string | null, limit: number, offset = 0): PendingEpisode[] {
  return db
    .prepare(
      `SELECT id, scope, body AS text, created_at, consolidated_into
       FROM episodes
       WHERE ${PENDING_WHERE}
       ORDER BY created_at DESC, rowid DESC LIMIT @limit OFFSET @offset`,
    )
    .all({ scope, limit, offset }) as PendingEpisode[];
}

/**
 * Reforzar lo que el recall devuelve premia a un recuerdo que aparece siempre y no sirve
 * nunca. Con el hook del cliente puesto, el refuerzo llega por `reinforce` y esto se apaga.
 */
function reinforcesOnRecall(): boolean {
  return (process.env.MISMEM_REINFORCE_ON_RECALL ?? "on").trim().toLowerCase() !== "off";
}

export interface RecallOptions {
  reinforce?: boolean;
  at?: number;
  embeddingModel?: string;
}

/**
 * Both recall paths rank traits first, then memories, then episodes, and cut to the limit;
 * the hit shape is built here so the two paths cannot drift apart.
 */
function finalizeHits(
  db: DB,
  layers: {
    traits: readonly Omit<RecallHit, "layer">[];
    memories: readonly RecallHit[];
    episodes: readonly Omit<RecallHit, "layer">[];
  },
  limit: number,
  options: RecallOptions,
  at: number,
): { hits: RecallHit[] } {
  const hits: RecallHit[] = [
    ...layers.traits.map((r) => ({ ...r, layer: "trait" as const })),
    ...layers.memories,
    ...layers.episodes.map((r) => ({ ...r, layer: "episode" as const })),
  ].slice(0, limit);

  if (options.reinforce ?? reinforcesOnRecall()) {
    reinforceMemories(
      db,
      hits.filter((h) => h.layer === "memory").map((h) => h.id),
      { at },
    );
  }

  return { hits };
}

/**
 * Índice hebbiano: cuenta el uso de cada recuerdo y el co-uso de cada par que
 * se usó en el mismo turno. Vive acá y no en `reinforceMemories` porque a esa
 * la llama también el camino de recall, donde aparecer no es haberse usado.
 */
function registrarUso(db: DB, memoryIds: readonly string[], at: number): void {
  const ids = [...new Set(memoryIds)].sort();
  if (ids.length === 0) return;

  const contar = db.prepare("UPDATE memories SET use_count = use_count + 1 WHERE id = ?");
  const emparejar = db.prepare(
    `INSERT INTO co_use (memory_a, memory_b, n, last_at) VALUES (?, ?, 1, ?)
     ON CONFLICT(memory_a, memory_b) DO UPDATE SET n = n + 1, last_at = excluded.last_at`,
  );

  db.transaction(() => {
    // The turn goes in the same transaction as the counts: the denominator must not
    // fall out of step with the numerators, not even through a failure mid-way.
    registerTurn(db);
    for (const id of ids) contar.run(id);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        emparejar.run(ids[i], ids[j], at);
      }
    }
  })();
}

/**
 * Refuerza los recuerdos que una respuesta usó de verdad.
 *
 * Los rasgos se cuentan aparte en vez de caer en `unknown`: la inyección también los
 * adelanta, así que mezclarlos dejaba esa alarma —la de "alguien manda ids inventados"—
 * sonando desde el primer día. Un rasgo gana fuerza al cristalizar, no al usarse.
 */
export function reinforce(
  db: DB,
  raw: unknown,
  options: { at?: number } = {},
): { reinforced: number; traits: number; unknown: number } {
  const input = ReinforceInput.parse(raw);
  const ids = [...new Set(input.memory_ids)];
  const marcadores = ids.map(() => "?").join(", ");
  const existentes = (tabla: string): string[] =>
    (
      db.prepare(`SELECT id FROM ${tabla} WHERE id IN (${marcadores})`).all(...ids) as Array<{
        id: string;
      }>
    ).map((row) => row.id);

  const known = existentes("memories");
  const traits = existentes("traits");

  reinforceMemories(db, known, { at: options.at, boost: input.boost });
  registrarUso(db, known, options.at ?? now());
  return {
    reinforced: known.length,
    traits: traits.length,
    unknown: ids.length - known.length - traits.length,
  };
}

/**
 * Recall léxico puro: es el camino sin capa semántica, así que siempre puede rescatar.
 * `recallHybrid` es quien apaga el rescate cuando hay vectores comparables que puntuar.
 */
export function recall(
  db: DB,
  raw: unknown,
  options: Pick<RecallOptions, "reinforce" | "at"> = {},
): { hits: RecallHit[] } {
  const input = RecallInput.parse(raw);
  const at = options.at ?? now();
  const lexical = lexicalCandidates(db, input, at);
  return finalizeHits(
    db,
    { traits: lexical.traits, memories: lexical.memories, episodes: lexical.episodes },
    input.limit,
    { ...options, reinforce: options.reinforce ?? input.reinforce },
    at,
  );
}

/**
 * Recall híbrido: FTS5 (léxico) + coseno sobre embeddings (semántico).
 * Si no hay embedder disponible (Ollama caído / MISMEM_EMBEDDINGS=off),
 * el resultado es idéntico a recall().
 */
export async function recallHybrid(
  db: DB,
  raw: unknown,
  embedFn?: EmbedFn,
  options: RecallOptions = {},
): Promise<{ hits: RecallHit[] }> {
  const input = RecallInput.parse(raw);
  const at = options.at ?? now();
  const cfg = loadEmbeddingConfig();
  const actualEmbedFn =
    embedFn ?? ((texts: string[]) => embedTexts(texts, cfg, "query"));

  const vecs = await actualEmbedFn([input.query]);
  // The query vector goes through the same check as a stored one: an injected embedFn or a
  // broken provider must degrade to lexical search, not carry NaN into the cosine.
  const queryVec = checkedUnitVectors(vecs ?? [])?.[0];
  const semanticModel = options.embeddingModel ?? (embedFn ? undefined : cfg.model);
  const semantic = queryVec
    ? semanticSearchMemories(db, queryVec, {
        scope: input.scope,
        limit: CANDIDATE_POOL_LIMIT,
        minScore: cfg.minScore,
        model: semanticModel,
      })
    : [];
  // El rescate léxico sólo entra cuando no hay capa semántica: embeddings apagados, el
  // embedder sin responder o ningún vector del modelo activo. Medido con 2.527 memorias, con
  // embeddings el rescate apenas suma aciertos y en cambio empuja la respuesta buena hacia
  // abajo y trae recuerdos a preguntas ajenas; sin ellos, es lo que lleva el recall de 0,1 a
  // 2,5 recuerdos por pregunta.
  const semanticLayer =
    queryVec !== undefined &&
    hasComparableVectors(db, { model: semanticModel, dims: queryVec.length, scope: input.scope });
  const lexical = lexicalCandidates(db, input, at, { rescue: !semanticLayer });
  const memories = queryVec ? fuseMemories(lexical.memories, semantic, at) : lexical.memories;
  return finalizeHits(
    db,
    { traits: lexical.traits, memories, episodes: lexical.episodes },
    input.limit,
    { ...options, reinforce: options.reinforce ?? input.reinforce },
    at,
  );
}

export function consolidate(
  db: DB,
  raw: unknown,
): { memory_id: string; consolidated: number } {
  const input = ConsolidateInput.parse(raw);
  const id = ulid();
  const ts = now();
  const sourceJson = JSON.stringify(input.source_episode_ids);

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO memories (
         id, scope, gist, details, source_episode_ids, salience, created_at,
         salience_updated_at
       )
       VALUES (?, ?, ?, ?, ?, 1.0, ?, ?)`,
    ).run(
      id,
      input.scope,
      input.gist,
      input.details ?? null,
      sourceJson,
      ts,
      ts,
    );

    const placeholders = input.source_episode_ids.map(() => "?").join(",");
    const upd = db.prepare(
      `UPDATE episodes SET consolidated_into = ?
       WHERE id IN (${placeholders}) AND scope = ?`,
    );
    const result = upd.run(id, ...input.source_episode_ids, input.scope);
    return result.changes;
  });

  const consolidated = tx();
  return { memory_id: id, consolidated };
}

export function crystallize(
  db: DB,
  raw: unknown,
): { trait_id: string; created: boolean; strength: number } {
  const input = CrystallizeInput.parse(raw);
  const ts = now();
  const evidenceJson = JSON.stringify(input.evidence_memory_ids);

  const existing = db
    .prepare("SELECT id, strength FROM traits WHERE scope = ? AND name = ?")
    .get(input.scope, input.name) as
    | { id: string; strength: number }
    | undefined;

  if (existing) {
    const newStrength = existing.strength + input.evidence_memory_ids.length;
    db.prepare(
      `UPDATE traits
       SET strength = ?, evidence_memory_ids = ?, polarity = ?, updated_at = ?
       WHERE id = ?`,
    ).run(newStrength, evidenceJson, input.polarity, ts, existing.id);
    return { trait_id: existing.id, created: false, strength: newStrength };
  }

  const id = ulid();
  db.prepare(
    `INSERT INTO traits (id, scope, name, evidence_memory_ids, strength, polarity, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.scope,
    input.name,
    evidenceJson,
    input.evidence_memory_ids.length,
    input.polarity,
    ts,
    ts,
  );
  return {
    trait_id: id,
    created: true,
    strength: input.evidence_memory_ids.length,
  };
}

export function forget(
  db: DB,
  raw: unknown,
): {
  episodes_to_delete: number;
  memories_to_delete: number;
  dry_run: boolean;
} {
  const input = ForgetInput.parse(raw);
  const at = now();
  const cutoff = at - input.before_days * 86_400_000;
  const memoryCutoff = at - input.memory_grace_days * 86_400_000;
  const scopeWhere = input.scope ? "AND scope = @scope" : "";
  const memoryScopeWhere = input.scope ? "AND m.scope = @scope" : "";
  // A memory is only forgettable once every episode still linked to it is past
  // before_days: forgetting it deletes those episodes too (ON DELETE SET NULL
  // would otherwise re-queue them for consolidation), so one newer episode keeps
  // the whole memory alive.
  const memoryRows = db
    .prepare(
      `SELECT m.id, m.salience, m.created_at, m.last_accessed_at, m.salience_updated_at
       FROM memories m
       WHERE m.created_at <= @memoryCutoff ${memoryScopeWhere}
         AND NOT EXISTS (
           SELECT 1 FROM episodes e
           WHERE e.consolidated_into = m.id
             AND e.created_at >= @cutoff
         )`,
    )
    .all({
      memoryCutoff,
      cutoff,
      scope: input.scope,
    }) as Array<SalienceRow & { id: string }>;
  const memoryIds = memoryRows
    .filter(
      (row) => effectiveSalience(row, at) < input.salience_below,
    )
    .map((row) => row.id);

  const episodeIds = new Set(
    (
      db
        .prepare(
          `SELECT id FROM episodes
           WHERE consolidated_into IS NOT NULL
             AND created_at < @cutoff ${scopeWhere}`,
        )
        .all({ cutoff, scope: input.scope }) as Array<{ id: string }>
    ).map((row) => row.id),
  );
  const linkedEpisodes = db.prepare(
    "SELECT id FROM episodes WHERE consolidated_into = ?",
  );
  for (const memoryId of memoryIds) {
    const rows = linkedEpisodes.all(memoryId) as Array<{ id: string }>;
    for (const row of rows) episodeIds.add(row.id);
  }

  if (!input.dry_run) {
    db.transaction(() => {
      decayMemories(db, { scope: input.scope, at });
      const deleteOldEpisodes = db.prepare(
        `DELETE FROM episodes
         WHERE consolidated_into IS NOT NULL
           AND created_at < @cutoff ${scopeWhere}`,
      );
      deleteOldEpisodes.run({ cutoff, scope: input.scope });
      const deleteLinkedEpisodes = db.prepare(
        "DELETE FROM episodes WHERE consolidated_into = ?",
      );
      const deleteMemory = db.prepare("DELETE FROM memories WHERE id = ?");
      for (const memoryId of memoryIds) {
        deleteLinkedEpisodes.run(memoryId);
        deleteMemory.run(memoryId);
      }
    })();
  }

  return {
    episodes_to_delete: episodeIds.size,
    memories_to_delete: memoryIds.length,
    dry_run: input.dry_run,
  };
}
