// Owns both recall paths, the switch that decides whether recall reinforces what it
// returns, and the hit shape they share.
import type { Database as DB } from "better-sqlite3";
import { RecallInput, type RecallHit } from "../schema.js";
import { CANDIDATE_POOL_LIMIT, lexicalCandidates } from "./lexical.js";
import { fuseMemories, hasComparableVectors } from "./fuse.js";
import { embedTexts, loadEmbeddingConfig, type EmbedFn } from "../embeddings/provider.js";
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
 * Pure lexical recall: the path with no semantic layer, so it can always rescue.
 * `recallHybrid` is what turns rescue off when there are comparable vectors to score.
 */
export function recall(
  db: DB,
  raw: unknown,
  options: Pick<RecallOptions, "reinforce" | "at"> = {},
): { hits: RecallHit[] } {
  const input = RecallInput.parse(raw);
  const at = options.at ?? Date.now();
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
  // Lexical rescue only comes in with no semantic layer: embeddings off, the embedder not
  // answering, or no vector of the active model. The measurement behind that cut is in
  // docs/recall.md#el-rescate.
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
