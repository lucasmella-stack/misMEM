/**
 * Loads the golden corpus into a throwaway DB and measures recall. Format: docs/recall.md.
 */
import type { Database as DB } from "better-sqlite3";
import { contentHash } from "../domain/hash.js";
import { isNoiseGist } from "../domain/noise.js";
import type { EmbedFn } from "../embeddings/provider.js";
import { mrr, recallAt, type Score } from "./bench.js";
import type { GoldenCorpus } from "./golden-corpus.js";
import { recallHybrid } from "./recall.js";

const DAY_MS = 86_400_000;

// Ids derived from the key, not ulid(): fused recall breaks exact ties by id, so random ids
// would let the same corpus rank differently from one run to the next and flake the CI floor.
const goldenId = (key: string, suffix = ""): string => `golden-${key}${suffix}`;

/**
 * Load the corpus with direct SQL, bypassing the tools: the eval measures recall, not the
 * write path. Each memory leaves its consolidated episode behind, as `consolidate` would,
 * so provenance is real instead of a made-up id.
 */
export function loadGolden(db: DB, corpus: GoldenCorpus, at: number): Map<string, string> {
  const ids = new Map<string, string>();
  const insertMemory = db.prepare(
    `INSERT INTO memories (
       id, scope, gist, details, source_episode_ids, salience, created_at,
       salience_updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertEpisode = db.prepare(
    `INSERT INTO episodes (id, scope, body, created_at, consolidated_into, content_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertTrait = db.prepare(
    `INSERT INTO traits (
       id, scope, name, evidence_memory_ids, strength, polarity, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, 1, 'neutral', ?, ?)`,
  );

  db.transaction(() => {
    for (const records of Object.values(corpus.domains)) {
      for (const record of records) {
        if (record.type !== "memory" && record.type !== "episode") continue;
        const createdAt = at - record.days_ago * DAY_MS;
        if (record.type === "memory") {
          const memoryId = goldenId(record.key);
          const episodeId = goldenId(record.key, "-source");
          const details = record.details ?? null;
          insertMemory.run(
            memoryId,
            record.scope,
            record.gist,
            details,
            JSON.stringify([episodeId]),
            record.salience ?? 1,
            createdAt,
            createdAt,
          );
          insertEpisode.run(episodeId, record.scope, record.gist, createdAt, memoryId, contentHash(record.gist));
          ids.set(record.key, memoryId);
          continue;
        }
        const episodeId = goldenId(record.key);
        insertEpisode.run(episodeId, record.scope, record.body, createdAt, null, contentHash(record.body));
        ids.set(record.key, episodeId);
      }
    }

    // Second pass: evidence may point at a memory from another file, or at a trait listed later,
    // so every trait id is known before any evidence is resolved.
    for (const records of Object.values(corpus.domains)) {
      for (const record of records) if (record.type === "trait") ids.set(record.key, goldenId(record.key));
    }
    for (const records of Object.values(corpus.domains)) {
      for (const record of records) {
        if (record.type !== "trait") continue;
        const evidence = record.evidence.map((key) => {
          const id = ids.get(key);
          if (!id) throw new Error(`golden: la evidencia ${key} no tiene id`);
          return id;
        });
        const traitId = goldenId(record.key);
        insertTrait.run(traitId, record.scope, record.name, JSON.stringify(evidence), at, at);
        ids.set(record.key, traitId);
      }
    }
  })();

  return ids;
}

export interface GoldenScore {
  questions: number;
  hitAt1: number;
  hitAt3: number;
  hitAtLimit: number;
  mrr: number;
}

export interface GoldenReport {
  limit: number;
  global: GoldenScore;
  kinds: Record<string, GoldenScore>;
  domains: Record<string, GoldenScore>;
  /** An off-topic question that returns anything is a false positive; `hitsSum` is how much. */
  offTopic: { withHits: number; total: number; hitsSum: number };
  /** The model reads everything returned: how many memories it pays per question. */
  returned: { hitsSum: number; questions: number };
  /** Noise markers that reached the cap: must be 0. */
  noiseHits: number;
}

export interface GoldenRunOptions {
  limit: number;
  embedFn?: EmbedFn;
  at: number;
}

function emptyScore(limit: number): Score {
  return { found: 0, total: 0, reciprocalSum: 0, rankSum: 0, ranks: Array<number>(limit).fill(0) };
}

function addRank(scores: Map<string, Score>, key: string, rank: number | null, limit: number): void {
  const score = scores.get(key) ?? emptyScore(limit);
  score.total++;
  if (rank !== null) {
    score.found++;
    score.reciprocalSum += 1 / rank;
    score.rankSum += rank;
    score.ranks[rank - 1] = (score.ranks[rank - 1] ?? 0) + 1;
  }
  scores.set(key, score);
}

function summarize(score: Score | undefined, limit: number): GoldenScore {
  const value = score ?? emptyScore(limit);
  return {
    questions: value.total,
    hitAt1: recallAt(value, 1),
    hitAt3: recallAt(value, 3),
    hitAtLimit: value.found,
    mrr: mrr(value),
  };
}

/**
 * A hit means the first returned hit whose key is in `expect`. Off-topic questions stay
 * out of the accuracy metrics (by contract they expect nothing) and are reported apart.
 */
export async function runGolden(
  db: DB,
  corpus: GoldenCorpus,
  ids: Map<string, string>,
  opts: GoldenRunOptions,
): Promise<GoldenReport> {
  const kindScores = new Map<string, Score>();
  const domainScores = new Map<string, Score>();
  const globalScores = new Map<string, Score>();
  const offTopic = { withHits: 0, total: 0, hitsSum: 0 };
  const returned = { hitsSum: 0, questions: 0 };
  let noiseHits = 0;

  for (const [domain, records] of Object.entries(corpus.domains)) {
    for (const record of records) {
      if (record.type !== "query") continue;
      const { hits } = await recallHybrid(
        db,
        { query: record.query, scope: record.scope, limit: opts.limit },
        opts.embedFn,
        { reinforce: false, at: opts.at },
      );
      noiseHits += hits.filter((hit) => isNoiseGist(hit.text)).length;

      if (record.kind === "ajena") {
        offTopic.total++;
        offTopic.withHits += hits.length > 0 ? 1 : 0;
        offTopic.hitsSum += hits.length;
        continue;
      }

      returned.hitsSum += hits.length;
      returned.questions++;
      const expected = new Set(
        record.expect.map((key) => ids.get(key)).filter((id): id is string => id !== undefined),
      );
      const index = hits.findIndex((hit) => expected.has(hit.id));
      const rank = index === -1 ? null : index + 1;
      addRank(kindScores, record.kind, rank, opts.limit);
      addRank(domainScores, domain, rank, opts.limit);
      addRank(globalScores, "", rank, opts.limit);
    }
  }

  const summary = (scores: Map<string, Score>): Record<string, GoldenScore> =>
    Object.fromEntries([...scores].map(([key, score]) => [key, summarize(score, opts.limit)]));

  return {
    limit: opts.limit,
    global: summarize(globalScores.get(""), opts.limit),
    kinds: summary(kindScores),
    domains: summary(domainScores),
    offTopic,
    returned,
    noiseHits,
  };
}
