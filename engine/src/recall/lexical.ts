// Owns the lexical candidate pool: the strict FTS query, its scope filters and the switch
// to the rescue, with the row types it returns.
import type { Database as DB } from "better-sqlite3";
import type { RecallInput, RecallHit } from "../schema.js";
import type { SalienceRow } from "../store/rows.js";
import { effectiveSalience } from "../memory/salience.js";
import { excludeNoiseSql } from "../store/rows.js";
import { escapeFts } from "./fts.js";
import {
  planTerms,
  relaxRows,
  relaxedFts,
  relaxedTerms,
  type RelaxedPlan,
} from "./rescue.js";

export const CANDIDATE_POOL_LIMIT = 50;
const MEMORY_FTS_SCAN_LIMIT = 200;

interface TraitCandidate {
  id: string;
  scope: string;
  text: string;
  created_at: number;
}

interface MemoryCandidate extends SalienceRow {
  id: string;
  scope: string;
  /** What is returned: the gist. */
  text: string;
  /** What FTS5 indexes and what is counted: gist and details. */
  search_text: string;
  fts_rank: number;
}

interface EpisodeCandidate {
  id: string;
  scope: string;
  text: string;
  created_at: number;
}

/** The minimum to order rescued candidates: text, id and FTS5 rank. */
export interface RankedCandidate {
  id: string;
  /** What is returned to the client. */
  text: string;
  /** What FTS5 indexes; when absent, `text` is scored (traits and episodes). */
  search_text?: string;
  fts_rank: number;
}

type RankedTrait = TraitCandidate & { fts_rank: number };
type RankedEpisode = EpisodeCandidate & { fts_rank: number };

export function lexicalCandidates(
  db: DB,
  input: ReturnType<typeof RecallInput.parse>,
  at: number,
  /** With no semantic layer answering, the rescue is the only thing that finds a natural phrase. */
  { rescue = true }: { rescue?: boolean } = {},
): {
  traits: RecallHit[];
  memories: RecallHit[];
  episodes: RecallHit[];
} {
  const strict = escapeFts(input.query);
  const scopeFilter = input.scope ? "AND t.scope = @scope" : "";

  const traitStmt = db.prepare(
    `SELECT t.id, t.scope, t.name AS text, t.created_at, rank AS fts_rank
     FROM traits_fts f JOIN traits t ON t.rowid = f.rowid
     WHERE traits_fts MATCH @q ${scopeFilter}
     ORDER BY rank, t.id LIMIT @limit`,
  );

  const memoryStmt = db.prepare(
    `SELECT m.id, m.scope, m.gist AS text,
            m.gist || ' ' || COALESCE(m.details, '') AS search_text,
            m.salience, m.created_at,
            m.last_accessed_at, m.salience_updated_at, rank AS fts_rank
     FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
     WHERE memories_fts MATCH @q ${input.scope ? "AND m.scope = @scope" : ""}
       AND ${excludeNoiseSql("m")}
     ORDER BY rank, m.salience DESC, m.id LIMIT @limit`,
  );

  const episodeStmt = db.prepare(
    `SELECT e.id, e.scope, e.body AS text, e.created_at, rank AS fts_rank
     FROM episodes_fts f JOIN episodes e ON e.rowid = f.rowid
     WHERE episodes_fts MATCH @q ${input.scope ? "AND e.scope = @scope" : ""}
       AND e.consolidated_into IS NULL
     ORDER BY e.created_at DESC, e.id LIMIT @limit`,
  );

  const run = (q: string): {
    traits: RankedTrait[];
    memories: MemoryCandidate[];
    episodes: RankedEpisode[];
  } => ({
    traits: traitStmt.all({ q, scope: input.scope, limit: CANDIDATE_POOL_LIMIT }) as RankedTrait[],
    memories: memoryStmt.all({
      q,
      scope: input.scope,
      limit: MEMORY_FTS_SCAN_LIMIT,
    }) as MemoryCandidate[],
    episodes: episodeStmt.all({ q, scope: input.scope, limit: CANDIDATE_POOL_LIMIT }) as RankedEpisode[],
  });

  // The strict query rules over the whole query: if it found anything in any layer, the
  // result is the usual one. Rescue only comes in when there was not a single candidate, so
  // a paraphrase does not alter a search that already worked.
  const strictRows = run(strict);
  const strictEmpty =
    strictRows.traits.length === 0 &&
    strictRows.memories.length === 0 &&
    strictRows.episodes.length === 0;
  // Frequency is only queried when a rescue is really needed: up to twelve counts over
  // memories_fts that a normal search must not pay for.
  let rescuedPlan: RelaxedPlan | null = null;
  let rows = strictRows;
  if (strictEmpty && rescue) {
    const { terms, wordCount } = relaxedTerms(input.query);
    const relaxed = relaxedFts(terms);
    if (relaxed !== strict) {
      rows = run(relaxed);
      // The presence gate is measured over the whole question, not over the capped search:
      // a word past the cap was part of what the question is about, and letting the cap
      // shrink the denominator would pass questions mostly about things no record has.
      rescuedPlan = planTerms(
        db,
        terms,
        wordCount,
        [...rows.traits, ...rows.memories, ...rows.episodes],
      );
    }
  }
  const traits: RecallHit[] = (
    rescuedPlan
      ? relaxRows(rows.traits, rescuedPlan)
      : rows.traits
  ).map(({ fts_rank: _ftsRank, ...row }) => ({ layer: "trait" as const, ...row }));
  const episodes: RecallHit[] = (
    rescuedPlan
      ? relaxRows(rows.episodes, rescuedPlan)
      : rows.episodes
  ).map(({ fts_rank: _ftsRank, ...row }) => ({ layer: "episode" as const, ...row }));

  // Rescue already comes ordered by matches and cut to RELAXED_MAX_RESULTS. The strict path
  // keeps FTS5's order and breaks ties by decayed salience: the raw value favoured what was
  // used long ago and is not what the client sees in the hit.
  const orderedMemories = rescuedPlan
    ? relaxRows(rows.memories, rescuedPlan)
    : rows.memories.sort(
        (a, b) =>
          Number(a.fts_rank) - Number(b.fts_rank) ||
          effectiveSalience(b, at) - effectiveSalience(a, at) ||
          a.id.localeCompare(b.id),
      );
  const memories: RecallHit[] = orderedMemories
    .slice(0, CANDIDATE_POOL_LIMIT)
    .map((r) => ({
      layer: "memory" as const,
      id: r.id,
      scope: r.scope,
      text: r.text,
      salience: effectiveSalience(r, at),
      created_at: r.created_at,
    }));

  return { traits, memories, episodes };
}
