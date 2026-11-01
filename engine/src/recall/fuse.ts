// Owns the fusion of every recall signal with RRF, where salience only breaks ties, and
// the check that decides whether the semantic layer has anything to score.
import type { Database as DB } from "better-sqlite3";
import type { RecallHit } from "../schema.js";
import type { SemanticHit } from "../embeddings/store.js";
import { effectiveSalience } from "../memory/salience.js";
import { excludeNoiseSql } from "../store/rows.js";

const RRF_K = 60;
// Below one RRF slot at the top (1/61 - 1/62 ≈ 0.00026), so salience only breaks ties there;
// lower down the slots shrink (≈ 0.00008 at the end of the 50 candidates) and a high
// salience can move two or three places.
const SALIENCE_RRF_WEIGHT = 0.0002;
// A trait is one broad rule, so it matches many questions by meaning and can crowd out the
// specific memory that answers them. On the golden corpus, letting the fusion return every
// trait dropped memory first hits from 329 to 293; keeping only the best one and up to two
// episodes (the rest of the result stays memories) restored 328 without losing a question
// type against the lexical baseline.
export const MAX_TRAIT_HITS = 1;
export const MAX_EPISODE_HITS = 2;
// A memory is already distilled and curated; an episode is raw and a trait is a compressed
// rule. On near-equal cosine, prefer the consolidated record. A layer still wins when its
// meaning is clearly closer, so this is a tie-break, not a restored layer order.
export const CONSOLIDATED_SEMANTIC_PRIOR = 0.05;
// A trait is one short, broad rule, so its cosine with any on-topic question runs high even
// when the rule is not what was asked. It must clear the shared threshold by a margin;
// episodes are long and specific enough to need a smaller one. Without either margin,
// general traits and long unrelated episodes made off-topic questions return something;
// 0.06 keeps 21/24 trait hits and 0.01 keeps 23/24 episode hits without raising that count.
export const TRAIT_SCORE_MARGIN = 0.06;
export const EPISODE_SCORE_MARGIN = 0.01;

export function semanticHitToRecall(hit: SemanticHit, at: number): RecallHit {
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

/**
 * Whether the semantic search has anything to score: a vector of the same model and dimensions
 * in scope. It applies the same filters as `semanticSearchMemories` but not the score cutoff:
 * a noise vector never scores, so it cannot turn the layer on.
 */
export function hasComparableVectors(
  db: DB,
  opts: { model?: string; dims: number; scope?: string },
): boolean {
  const filters = [
    opts.scope ? "m.scope = @scope" : null,
    opts.model ? "e.model = @model" : null,
    "e.dims = @dims",
    excludeNoiseSql("m"),
  ].filter((value): value is string => value !== null);
  return (
    db
      .prepare(
        `SELECT 1 FROM memory_embeddings e JOIN memories m ON m.id = e.memory_id
         WHERE ${filters.join(" AND ")} LIMIT 1`,
      )
      .get({ scope: opts.scope, model: opts.model, dims: opts.dims }) !== undefined
  );
}

export interface RankedSource {
  hits: readonly RecallHit[];
  /** Relative weight of the source in the fusion; 1 for the words of the query. */
  weight: number;
}

/**
 * One list for all three layers: each source contributes 1/(K + rank), so a hit found by
 * several signals (exact words, meaning, the rescue) rises, and no layer keeps a fixed
 * step over another. Salience only breaks ties, as it did among memories.
 */
export function fuseHits(sources: readonly RankedSource[]): RecallHit[] {
  const candidates = new Map<string, { hit: RecallHit; rrf: number }>();

  for (const source of sources) {
    source.hits.forEach((hit, index) => {
      // Every layer has the same source weight. A 1.15 trait multiplier was measured to
      // move a trait nine ranks ahead of a memory at the top (1.15/61 vs 1/61); on the
      // golden corpus that made memories lose the first place without a compensating win.
      const contribution = source.weight / (RRF_K + index + 1);
      const key = `${hit.layer}:${hit.id}`;
      const current = candidates.get(key);
      if (current) {
        current.rrf += contribution;
        return;
      }
      candidates.set(key, { hit, rrf: contribution });
    });
  }

  return [...candidates.values()]
    .sort((a, b) => {
      const scoreA = a.rrf + (a.hit.salience ?? 0) * SALIENCE_RRF_WEIGHT;
      const scoreB = b.rrf + (b.hit.salience ?? 0) * SALIENCE_RRF_WEIGHT;
      return (
        scoreB - scoreA ||
        (b.hit.salience ?? 0) - (a.hit.salience ?? 0) ||
        b.hit.created_at - a.hit.created_at ||
        a.hit.id.localeCompare(b.hit.id)
      );
    })
    .map(({ hit }) => hit);
}
