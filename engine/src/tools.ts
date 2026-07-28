import type { Database as DB } from "better-sqlite3";
import { ulid } from "ulid";
import {
  CaptureInput,
  RecallInput,
  ConsolidateInput,
  CrystallizeInput,
  ForgetInput,
  type RecallHit,
} from "./schema.js";
import { contentHash } from "./db.js";
import {
  embedTexts,
  loadEmbeddingConfig,
  semanticSearchMemories,
  type EmbedFn,
  type SemanticHit,
} from "./embeddings/index.js";
import {
  decayMemories,
  effectiveSalience,
  reinforceMemories,
  type SalienceRow,
} from "./salience.js";

const now = (): number => Date.now();
const CANDIDATE_POOL_LIMIT = 50;
const MEMORY_FTS_SCAN_LIMIT = 200;
const RRF_K = 60;
// Mantiene la ventaja de aparecer en ambos rankings, sin volver inmortal a un
// hit de salience mínima frente a una alternativa semántica muy relevante.
const SALIENCE_RRF_WEIGHT = 0.02;

function escapeFts(query: string): string {
  // Escape FTS5 special chars by quoting tokens. Conservative: split on spaces.
  // If query is empty/whitespace, fall back to a token that matches nothing
  // safely (avoids invalid FTS5 MATCH expression).
  const escaped = query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" ");
  return escaped || '""';
}

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

export interface RecallOptions {
  reinforce?: boolean;
  at?: number;
  embeddingModel?: string;
}

interface TraitCandidate {
  id: string;
  scope: string;
  text: string;
  created_at: number;
}

interface MemoryCandidate extends SalienceRow {
  id: string;
  scope: string;
  text: string;
  created_at: number;
  fts_rank: number;
}

interface EpisodeCandidate {
  id: string;
  scope: string;
  text: string;
  created_at: number;
}

function lexicalCandidates(
  db: DB,
  input: ReturnType<typeof RecallInput.parse>,
  at: number,
): {
  traits: TraitCandidate[];
  memories: RecallHit[];
  episodes: EpisodeCandidate[];
} {
  const fts = escapeFts(input.query);
  const scopeFilter = input.scope ? "AND t.scope = @scope" : "";

  const traitRows = db
    .prepare(
      `SELECT t.id, t.scope, t.name AS text, t.created_at
       FROM traits_fts f JOIN traits t ON t.rowid = f.rowid
       WHERE traits_fts MATCH @q ${scopeFilter}
       ORDER BY rank, t.id LIMIT @limit`,
    )
    .all({
      q: fts,
      scope: input.scope,
      limit: CANDIDATE_POOL_LIMIT,
    }) as TraitCandidate[];

  const memoryRows = db
    .prepare(
      `SELECT m.id, m.scope, m.gist AS text, m.salience, m.created_at,
              m.last_accessed_at, m.salience_updated_at, rank AS fts_rank
       FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
       WHERE memories_fts MATCH @q ${input.scope ? "AND m.scope = @scope" : ""}
       ORDER BY m.salience DESC, rank, m.id LIMIT @limit`,
    )
    .all({
      q: fts,
      scope: input.scope,
      limit: MEMORY_FTS_SCAN_LIMIT,
    }) as MemoryCandidate[];

  const episodeRows = db
    .prepare(
      `SELECT e.id, e.scope, e.body AS text, e.created_at
       FROM episodes_fts f JOIN episodes e ON e.rowid = f.rowid
       WHERE episodes_fts MATCH @q ${input.scope ? "AND e.scope = @scope" : ""}
         AND e.consolidated_into IS NULL
       ORDER BY e.created_at DESC, e.id LIMIT @limit`,
    )
    .all({
      q: fts,
      scope: input.scope,
      limit: CANDIDATE_POOL_LIMIT,
    }) as EpisodeCandidate[];

  const memories: RecallHit[] = memoryRows
    .map((r) => ({
      layer: "memory" as const,
      id: r.id,
      scope: r.scope,
      text: r.text,
      salience: effectiveSalience(r, at),
      created_at: r.created_at,
      fts_rank: r.fts_rank,
    }))
    .sort(
      (a, b) =>
        (b.salience ?? 0) - (a.salience ?? 0) ||
        Number(a.fts_rank) - Number(b.fts_rank) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, CANDIDATE_POOL_LIMIT)
    .map(({ fts_rank: _ftsRank, ...hit }) => hit);

  return { traits: traitRows, memories, episodes: episodeRows };
}

function finalizeHits(
  db: DB,
  hits: RecallHit[],
  options: RecallOptions,
  at: number,
): { hits: RecallHit[] } {
  if (options.reinforce ?? true) {
    reinforceMemories(
      db,
      hits.filter((h) => h.layer === "memory").map((h) => h.id),
      { at },
    );
  }

  return { hits };
}

export function recall(
  db: DB,
  raw: unknown,
  options: Pick<RecallOptions, "reinforce" | "at"> = {},
): { hits: RecallHit[] } {
  const input = RecallInput.parse(raw);
  const at = options.at ?? now();
  const lexical = lexicalCandidates(db, input, at);
  const hits: RecallHit[] = [
    ...lexical.traits.map((r) => ({ ...r, layer: "trait" as const })),
    ...lexical.memories,
    ...lexical.episodes.map((r) => ({ ...r, layer: "episode" as const })),
  ].slice(0, input.limit);
  return finalizeHits(db, hits, options, at);
}

function semanticHitToRecall(hit: SemanticHit, at: number): RecallHit {
  return {
    layer: "memory",
    id: hit.id,
    scope: hit.scope,
    text: hit.text,
    salience: effectiveSalience(hit, at),
    created_at: hit.created_at,
    via: "semantic",
  };
}

function fuseMemories(
  lexical: RecallHit[],
  semantic: SemanticHit[],
  at: number,
): RecallHit[] {
  const candidates = new Map<
    string,
    { hit: RecallHit; rrf: number }
  >();

  lexical.forEach((hit, index) => {
    candidates.set(hit.id, {
      hit,
      rrf: 1 / (RRF_K + index + 1),
    });
  });

  semantic.forEach((row, index) => {
    const current = candidates.get(row.id);
    if (current) {
      current.rrf += 1 / (RRF_K + index + 1);
      return;
    }
    candidates.set(row.id, {
      hit: semanticHitToRecall(row, at),
      rrf: 1 / (RRF_K + index + 1),
    });
  });

  return [...candidates.values()]
    .sort((a, b) => {
      const scoreA =
        a.rrf + (a.hit.salience ?? 0) * SALIENCE_RRF_WEIGHT;
      const scoreB =
        b.rrf + (b.hit.salience ?? 0) * SALIENCE_RRF_WEIGHT;
      return (
        scoreB - scoreA ||
        (b.hit.salience ?? 0) - (a.hit.salience ?? 0) ||
        b.hit.created_at - a.hit.created_at ||
        a.hit.id.localeCompare(b.hit.id)
      );
    })
    .map(({ hit }) => hit);
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
  const lexical = lexicalCandidates(db, input, at);
  const cfg = loadEmbeddingConfig();
  const actualEmbedFn =
    embedFn ?? ((texts: string[]) => embedTexts(texts, cfg));

  const vecs = await actualEmbedFn([input.query]);
  const queryVec = vecs?.[0];
  const semantic = queryVec
    ? semanticSearchMemories(db, queryVec, {
        scope: input.scope,
        limit: CANDIDATE_POOL_LIMIT,
        model: options.embeddingModel ?? (embedFn ? undefined : cfg.model),
      })
    : [];
  const memories = queryVec
    ? fuseMemories(lexical.memories, semantic, at)
    : lexical.memories;
  const hits: RecallHit[] = [
    ...lexical.traits.map((r) => ({ ...r, layer: "trait" as const })),
    ...memories,
    ...lexical.episodes.map((r) => ({ ...r, layer: "episode" as const })),
  ].slice(0, input.limit);

  return finalizeHits(db, hits, options, at);
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
  const memoryRows = db
    .prepare(
      `SELECT id, salience, created_at, last_accessed_at, salience_updated_at
       FROM memories
       WHERE created_at <= @memoryCutoff ${scopeWhere}`,
    )
    .all({
      memoryCutoff,
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
