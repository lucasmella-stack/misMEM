// Measures recall against a private question bank that lives outside the repo, because it
// comes from each person's memory. Never reinforces: measuring cannot change what is
// remembered later.
import type { Database as DB } from "better-sqlite3";
import { z } from "zod";
import type { EmbedFn } from "../embeddings/provider.js";
import { isNoiseGist } from "../domain/noise.js";
import { recallHybrid } from "../recall/recall.js";

const BankLine = z.object({ id: z.string().min(1) }).catchall(z.string());

interface BankEntry {
  id: string;
  groups: Record<string, string>;
  queries: Record<string, string>;
}

export interface Bank {
  variants: string[];
  entries: BankEntry[];
}

export interface Score {
  /** Hits within the limit: ordinary recall. */
  found: number;
  total: number;
  /** Sum of 1/position of the hits; divided by total it gives the MRR. */
  reciprocalSum: number;
  /** Sum of the hits' positions; divided by found it gives the mean rank. */
  rankSum: number;
  /** How many hits landed in each position; index 0 is the first. */
  ranks: number[];
}

export interface BenchReport {
  limit: number;
  variants: Record<string, { all: Score; groups: Record<string, Score> }>;
  /** An off-topic question that returns anything is a false positive; `hitsSum` says how much. */
  offTopic: { withHits: number; total: number; hitsSum: number };
  /** The model reads everything returned: how many memories it pays per question. */
  returned: { hitsSum: number; questions: number };
  /**
   * Noise markers that reached any limit. They are `forget` bookkeeping, not knowledge:
   * this has to be 0. If it rises, the filter in `noise.ts` broke.
   */
  noiseHits: number;
}

export interface BenchOptions {
  limit: number;
  embedFn?: EmbedFn;
  offTopic?: string[];
}

/** One JSON line per question: the expected memory's `id`, group keys and one key per variant. */
export function parseBank(text: string, groupKeys: string[]): Bank {
  const variants: string[] = [];
  const entries: BankEntry[] = [];
  text.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    let parsed: z.infer<typeof BankLine>;
    try {
      parsed = BankLine.parse(JSON.parse(line));
    } catch (err) {
      throw new Error(`banco inválido en la línea ${index + 1}: ${(err as Error).message}`);
    }
    const entry: BankEntry = { id: parsed.id, groups: {}, queries: {} };
    for (const [key, value] of Object.entries(parsed)) {
      if (key === "id") continue;
      if (groupKeys.includes(key)) {
        entry.groups[key] = value;
        continue;
      }
      entry.queries[key] = value;
      if (!variants.includes(key)) variants.push(key);
    }
    entries.push(entry);
  });
  return { variants, entries };
}

function emptyScore(limit: number): Score {
  return { found: 0, total: 0, reciprocalSum: 0, rankSum: 0, ranks: Array(limit).fill(0) };
}

/** `rank` is the hit's 1-based position, or null when it did not make the limit. */
function bump(score: Score | undefined, rank: number | null, limit: number): Score {
  const next = score ?? emptyScore(limit);
  if (rank === null) return { ...next, total: next.total + 1 };
  return {
    found: next.found + 1,
    total: next.total + 1,
    reciprocalSum: next.reciprocalSum + 1 / rank,
    rankSum: next.rankSum + rank,
    ranks: next.ranks.map((n, i) => (i === rank - 1 ? n + 1 : n)),
  };
}

/**
 * Hits in the first `k` positions. A client that shows 3 does not see the fifth, so recall
 * over the whole limit can promise more than the model reads.
 */
export function recallAt(score: Score, k: number): number {
  return score.ranks.slice(0, k).reduce((sum, n) => sum + n, 0);
}

export function mrr(score: Score): number {
  return score.total === 0 ? 0 : score.reciprocalSum / score.total;
}

/** Mean position of the hits; NaN when there were none. */
export function meanRank(score: Score): number {
  return score.found === 0 ? Number.NaN : score.rankSum / score.found;
}

export async function runBench(db: DB, bank: Bank, opts: BenchOptions): Promise<BenchReport> {
  const report: BenchReport = {
    limit: opts.limit,
    variants: {},
    offTopic: { withHits: 0, total: 0, hitsSum: 0 },
    returned: { hitsSum: 0, questions: 0 },
    noiseHits: 0,
  };
  const ask = async (query: string) => {
    const hits = (
      await recallHybrid(db, { query, limit: opts.limit }, opts.embedFn, { reinforce: false })
    ).hits;
    report.noiseHits += hits.filter((hit) => isNoiseGist(hit.text)).length;
    return hits;
  };

  for (const variant of bank.variants) {
    const result: { all: Score; groups: Record<string, Score> } = {
      all: emptyScore(opts.limit),
      groups: {},
    };
    for (const entry of bank.entries) {
      const query = entry.queries[variant];
      if (!query) continue;
      const hits = await ask(query);
      const index = hits.findIndex((hit) => hit.id === entry.id);
      const rank = index === -1 ? null : index + 1;
      report.returned.hitsSum += hits.length;
      report.returned.questions++;
      result.all = bump(result.all, rank, opts.limit);
      for (const [key, value] of Object.entries(entry.groups)) {
        const label = `${key}=${value}`;
        result.groups[label] = bump(result.groups[label], rank, opts.limit);
      }
    }
    report.variants[variant] = result;
  }

  for (const query of opts.offTopic ?? []) {
    const hits = await ask(query);
    report.offTopic = {
      withHits: report.offTopic.withHits + (hits.length > 0 ? 1 : 0),
      total: report.offTopic.total + 1,
      hitsSum: report.offTopic.hitsSum + hits.length,
    };
  }
  return report;
}
