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
  semanticSearchMemories,
  type EmbedFn,
} from "./embeddings/index.js";

const now = (): number => Date.now();

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

export function recall(db: DB, raw: unknown): { hits: RecallHit[] } {
  const input = RecallInput.parse(raw);
  const fts = escapeFts(input.query);
  const scopeFilter = input.scope ? "AND t.scope = @scope" : "";

  const traitRows = db
    .prepare(
      `SELECT t.id, t.scope, t.name AS text, t.created_at
       FROM traits_fts f JOIN traits t ON t.rowid = f.rowid
       WHERE traits_fts MATCH @q ${scopeFilter}
       ORDER BY rank LIMIT @limit`,
    )
    .all({ q: fts, scope: input.scope, limit: input.limit }) as Array<{
    id: string;
    scope: string;
    text: string;
    created_at: number;
  }>;

  const memoryRows = db
    .prepare(
      `SELECT m.id, m.scope, m.gist AS text, m.salience, m.created_at
       FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
       WHERE memories_fts MATCH @q ${input.scope ? "AND m.scope = @scope" : ""}
       ORDER BY m.salience DESC, rank LIMIT @limit`,
    )
    .all({ q: fts, scope: input.scope, limit: input.limit }) as Array<{
    id: string;
    scope: string;
    text: string;
    salience: number;
    created_at: number;
  }>;

  const episodeRows = db
    .prepare(
      `SELECT e.id, e.scope, e.body AS text, e.created_at
       FROM episodes_fts f JOIN episodes e ON e.rowid = f.rowid
       WHERE episodes_fts MATCH @q ${input.scope ? "AND e.scope = @scope" : ""}
         AND e.consolidated_into IS NULL
       ORDER BY e.created_at DESC LIMIT @limit`,
    )
    .all({ q: fts, scope: input.scope, limit: input.limit }) as Array<{
    id: string;
    scope: string;
    text: string;
    created_at: number;
  }>;

  const hits: RecallHit[] = [
    ...traitRows.map((r) => ({ ...r, layer: "trait" as const })),
    ...memoryRows.map((r) => ({ ...r, layer: "memory" as const })),
    ...episodeRows.map((r) => ({ ...r, layer: "episode" as const })),
  ].slice(0, input.limit);

  // Hebb: refuerzo lo que recuperé
  const ts = now();
  const bumpMem = db.prepare(
    "UPDATE memories SET salience = MIN(1.0, salience + 0.05), last_accessed_at = ? WHERE id = ?",
  );
  for (const h of hits) if (h.layer === "memory") bumpMem.run(ts, h.id);

  return { hits };
}

/**
 * Recall híbrido: FTS5 (léxico) + coseno sobre embeddings (semántico).
 * Si no hay embedder disponible (Ollama caído / MISMEM_EMBEDDINGS=off),
 * el resultado es idéntico a recall().
 */
export async function recallHybrid(
  db: DB,
  raw: unknown,
  embedFn: EmbedFn = (texts) => embedTexts(texts),
): Promise<{ hits: RecallHit[] }> {
  const input = RecallInput.parse(raw);
  const lexical = recall(db, raw);
  if (lexical.hits.length >= input.limit) return lexical;

  const vecs = await embedFn([input.query]);
  const queryVec = vecs?.[0];
  if (!queryVec) return lexical;

  const seen = new Set(lexical.hits.map((h) => h.id));
  const semantic = semanticSearchMemories(db, queryVec, {
    scope: input.scope,
    limit: input.limit,
  }).filter((s) => !seen.has(s.id));

  const extra: RecallHit[] = semantic
    .slice(0, input.limit - lexical.hits.length)
    .map((s) => ({
      layer: "memory" as const,
      id: s.id,
      scope: s.scope,
      text: s.text,
      salience: s.salience,
      created_at: s.created_at,
      via: "semantic" as const,
    }));

  // Hebb también para lo recuperado semánticamente.
  const ts = now();
  const bumpMem = db.prepare(
    "UPDATE memories SET salience = MIN(1.0, salience + 0.05), last_accessed_at = ? WHERE id = ?",
  );
  for (const h of extra) bumpMem.run(ts, h.id);

  return { hits: [...lexical.hits, ...extra] };
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
      `INSERT INTO memories (id, scope, gist, details, source_episode_ids, salience, created_at)
       VALUES (?, ?, ?, ?, ?, 1.0, ?)`,
    ).run(id, input.scope, input.gist, input.details ?? null, sourceJson, ts);

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
  const cutoff = now() - input.before_days * 86_400_000;
  const scopeWhere = input.scope ? "AND scope = @scope" : "";

  const epCount = db
    .prepare(
      `SELECT COUNT(*) AS n FROM episodes
       WHERE consolidated_into IS NOT NULL AND created_at < @cutoff ${scopeWhere}`,
    )
    .get({ cutoff, scope: input.scope }) as { n: number };

  const memCount = db
    .prepare(
      `SELECT COUNT(*) AS n FROM memories
       WHERE salience < @threshold ${scopeWhere}`,
    )
    .get({ threshold: input.salience_below, scope: input.scope }) as {
    n: number;
  };

  if (!input.dry_run) {
    db.prepare(
      `DELETE FROM episodes
       WHERE consolidated_into IS NOT NULL AND created_at < @cutoff ${scopeWhere}`,
    ).run({ cutoff, scope: input.scope });
    db.prepare(
      `DELETE FROM memories WHERE salience < @threshold ${scopeWhere}`,
    ).run({ threshold: input.salience_below, scope: input.scope });
  }

  return {
    episodes_to_delete: epCount.n,
    memories_to_delete: memCount.n,
    dry_run: input.dry_run,
  };
}
