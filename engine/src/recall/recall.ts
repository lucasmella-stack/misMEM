// Owns both recall paths, the switch that decides whether recall reinforces what it
// returns, and the hit shape they share.
import type { Database as DB } from "better-sqlite3";
import { RecallInput, type RecallHit } from "../schema.js";
import { CANDIDATE_POOL_LIMIT, lexicalCandidates } from "./lexical.js";
import {
  CONSOLIDATED_SEMANTIC_PRIOR,
  EPISODE_SCORE_MARGIN,
  MAX_EPISODE_HITS,
  MAX_TRAIT_HITS,
  TRAIT_SCORE_MARGIN,
  fuseHits,
  hasComparableVectors,
  semanticHitToRecall,
  type RankedSource,
} from "./fuse.js";
import { embedTexts, loadEmbeddingConfig, type EmbedFn } from "../embeddings/provider.js";
import {
  hasComparableLayerVectors,
  semanticSearchLayer,
  type LayerSemanticHit,
} from "../embeddings/layers.js";
import { semanticSearchMemories } from "../embeddings/store.js";
import { checkedUnitVectors } from "../embeddings/vector.js";
import { reinforceMemories } from "../memory/salience.js";

/**
 * Reinforcing what recall returns rewards a memory that always shows up and never helps.
 * With the client hook in place, reinforcement arrives through `reinforce` and this is off.
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
 * Both recall paths hand over one already-ranked list: the layers compete instead of
 * being concatenated, so the limit cannot cut off a whole layer that no longer has a
 * fixed position. The hit shape and the reinforcement stay here so the paths cannot drift.
 */
function finalizeHits(
  db: DB,
  ranked: readonly RecallHit[],
  limit: number,
  options: RecallOptions,
  at: number,
): { hits: RecallHit[] } {
  const hits = ranked.slice(0, limit);

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
 * Pure lexical recall: the path with no semantic layer, so it can always rescue.
 * `recallHybrid` is what turns rescue off when the memories have comparable vectors to score.
 */
export function recall(
  db: DB,
  raw: unknown,
  options: Pick<RecallOptions, "reinforce" | "at"> = {},
): { hits: RecallHit[] } {
  const input = RecallInput.parse(raw);
  const at = options.at ?? Date.now();
  const lexical = lexicalCandidates(db, input, at);
  // The rescue only fills a strict search that found nothing, so it does not need a
  // smaller weight: it is the only signal in that result.
  const ranked = fuseHits([
    { hits: lexical.traits, weight: 1 },
    { hits: lexical.memories, weight: 1 },
    { hits: lexical.episodes, weight: 1 },
  ]);
  return finalizeHits(
    db,
    ranked,
    input.limit,
    { ...options, reinforce: options.reinforce ?? input.reinforce },
    at,
  );
}

function layerHitToRecall(hit: LayerSemanticHit, layer: "trait" | "episode"): RecallHit {
  return {
    layer,
    id: hit.id,
    scope: hit.scope,
    text: hit.text,
    created_at: hit.created_at,
    via: "semantic",
  };
}

/**
 * Hybrid recall: FTS5 (lexical) plus cosine over embeddings (semantic). With no embedder
 * available (server down / MISMEM_EMBEDDINGS=off) the result is identical to `recall()`.
 */
export async function recallHybrid(
  db: DB,
  raw: unknown,
  embedFn?: EmbedFn,
  options: RecallOptions = {},
): Promise<{ hits: RecallHit[] }> {
  const input = RecallInput.parse(raw);
  const at = options.at ?? Date.now();
  const cfg = loadEmbeddingConfig();
  const actualEmbedFn =
    embedFn ?? ((texts: string[]) => embedTexts(texts, cfg, "query"));

  const vecs = await actualEmbedFn([input.query]);
  // The query vector goes through the same check as a stored one: an injected embedFn or a
  // broken provider must degrade to lexical search, not carry NaN into the cosine.
  const queryVec = checkedUnitVectors(vecs ?? [])?.[0] ?? undefined;
  const semanticModel = options.embeddingModel ?? (embedFn ? undefined : cfg.model);
  const semantic = queryVec
    ? semanticSearchMemories(db, queryVec, {
        scope: input.scope,
        limit: CANDIDATE_POOL_LIMIT,
        minScore: cfg.minScore,
        model: semanticModel,
      })
    : [];
  // The rescue fills what the strict search missed, so it stays on until the memories
  // themselves have vectors to compete with. A layer vector alone (an episode embedded at
  // capture on a base whose memories were never indexed) scores no memory, and switching the
  // rescue off there loses every memory the strict query does not match.
  const hasMemoryVectors =
    queryVec !== undefined &&
    hasComparableVectors(db, {
      model: semanticModel,
      dims: queryVec.length,
      scope: input.scope,
    });
  // The semantic layer is on with any comparable vector: traits and episodes compete on
  // cosine even when no memory vector exists yet. The measurement behind the rescue cut is in
  // docs/recall.md#el-rescate.
  const semanticLayer =
    hasMemoryVectors ||
    (queryVec !== undefined &&
      hasComparableLayerVectors(db, {
        model: semanticModel,
        dims: queryVec.length,
        scope: input.scope,
      }));
  const lexical = lexicalCandidates(db, input, at, { rescue: !hasMemoryVectors });

  // One semantic ranking for the three layers: a trait or pending episode must beat a
  // memory on cosine to pass it, instead of inheriting a full rank-1 share from its own
  // short list. That keeps the layers competing by meaning, not by list membership.
  const semanticTraits = queryVec
    ? semanticSearchLayer(db, "trait", queryVec, {
        scope: input.scope,
        limit: CANDIDATE_POOL_LIMIT,
        minScore: cfg.minScore + TRAIT_SCORE_MARGIN,
        model: semanticModel,
      })
    : [];
  const semanticEpisodes = queryVec
    ? semanticSearchLayer(db, "episode", queryVec, {
        scope: input.scope,
        limit: CANDIDATE_POOL_LIMIT,
        minScore: cfg.minScore + EPISODE_SCORE_MARGIN,
        model: semanticModel,
      })
    : [];

  // The quota is decided by the cosine order before the fusion, never by the fused
  // order: a trait that entered only through an exact word must not displace the trait
  // that is closest in meaning. A layer with no vector past its margin (none stored yet, or
  // none close enough) falls back to its first lexical candidates.
  const quota = (
    semanticIds: readonly string[],
    lexicalIds: readonly string[],
    max: number,
  ): Set<string> =>
    new Set((semanticIds.length > 0 ? semanticIds : lexicalIds).slice(0, max));
  const allowedTraits = quota(
    semanticTraits.map((hit) => hit.id),
    lexical.traits.map((hit) => hit.id),
    MAX_TRAIT_HITS,
  );
  const allowedEpisodes = quota(
    semanticEpisodes.map((hit) => hit.id),
    lexical.episodes.map((hit) => hit.id),
    MAX_EPISODE_HITS,
  );
  // Without any comparable vector there is no semantic cut to trim: the lexical fallback
  // keeps its calibrated order, which is why the quota only applies to the hybrid result.
  const keepAllowed = (hits: readonly RecallHit[]): RecallHit[] =>
    semanticLayer
      ? hits.filter(
          (hit) =>
            hit.layer === "memory" ||
            (hit.layer === "trait" ? allowedTraits : allowedEpisodes).has(hit.id),
        )
      : [...hits];

  // Every signal is a source in one RRF fusion: an exact word match, a stored memory
  // vector, and the stored vectors of traits and pending episodes. A hit found by several
  // signals rises; no layer keeps a fixed step over another.
  const sources: RankedSource[] = [
    { hits: lexical.traits, weight: 1 },
    { hits: lexical.memories, weight: 1 },
    { hits: lexical.episodes, weight: 1 },
  ];
  if (queryVec) {
    // Stable on purpose: an exact tie keeps the source order, which already applies
    // salience for memories and id for layer rows. Re-sorting by id would erase that.
    const byMeaning = [
      ...semantic.map((hit) => ({
        hit: semanticHitToRecall(hit, at),
        score: hit.score + CONSOLIDATED_SEMANTIC_PRIOR,
      })),
      ...semanticTraits.map((hit) => ({ hit: layerHitToRecall(hit, "trait"), score: hit.score })),
      ...semanticEpisodes.map((hit) => ({
        hit: layerHitToRecall(hit, "episode"),
        score: hit.score,
      })),
    ]
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.hit);
    // Trim before fusion so the quota keeps its rank positions and a memory does not lose
    // a place to a trait or episode the result will drop anyway.
    sources.push({ hits: keepAllowed(byMeaning), weight: 1 });
  }

  return finalizeHits(
    db,
    keepAllowed(fuseHits(sources)),
    input.limit,
    { ...options, reinforce: options.reinforce ?? input.reinforce },
    at,
  );
}
