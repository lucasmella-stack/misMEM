/**
 * Golden eval: a public, synthetic corpus that measures recall without the private bank.
 *
 * The corpus is JSONL (one file per domain) loaded into a throwaway DB. No network: load
 * and run are pure, and the embedder is injected as in `bench.ts`. Off-topic questions are
 * measured apart because they cannot possibly hit.
 */
import { basename } from "node:path";
import type { Database as DB } from "better-sqlite3";
import { z } from "zod";
import { mrr, recallAt, type Score } from "./bench.js";
import type { EmbedFn } from "./embeddings/provider.js";
import { contentHash } from "./hash.js";
import { isNoiseGist } from "./noise.js";
import { Scope } from "./schema.js";
import { recallHybrid } from "./tools.js";

const DAY_MS = 86_400_000;

// Ids derived from the key, not ulid(): fused recall breaks exact ties by id, so random ids
// would let the same corpus rank differently from one run to the next and flake the CI floor.
const goldenId = (key: string, suffix = ""): string => `golden-${key}${suffix}`;

const GOLDEN_KINDS = [
  "literal",
  "parafrasis",
  "sinonimo",
  "coloquial",
  "sin_tildes",
  "errata",
  "ingles",
  "larga",
  "clave",
  "ambito",
  "episodio",
  "rasgo",
  "ajena",
] as const;

const Key = z.string().min(1);
const DaysAgo = z.number().int().nonnegative();

const MemoryLine = z.object({
  type: z.literal("memory"),
  key: Key,
  scope: Scope,
  gist: z.string().min(1),
  details: z.string().optional(),
  days_ago: DaysAgo,
  salience: z.number().min(0).max(1).optional(),
});

const TraitLine = z.object({
  type: z.literal("trait"),
  key: Key,
  scope: Scope,
  name: z.string().min(1),
  evidence: z.array(Key).min(1),
});

const EpisodeLine = z.object({
  type: z.literal("episode"),
  key: Key,
  scope: Scope,
  body: z.string().min(1),
  days_ago: DaysAgo,
});

const QueryLine = z.object({
  type: z.literal("query"),
  id: Key,
  kind: z.enum(GOLDEN_KINDS),
  query: z.string().min(1),
  expect: z.array(Key),
  scope: Scope.optional(),
});

const GoldenLine = z.discriminatedUnion("type", [MemoryLine, TraitLine, EpisodeLine, QueryLine]);
type GoldenLineData = z.infer<typeof GoldenLine>;
type GoldenRecord = GoldenLineData & { domain: string };

export interface GoldenFile {
  name: string;
  text: string;
}

export interface GoldenCorpus {
  /** One list per file (the name without `.jsonl` is the domain), in read order. */
  domains: Record<string, GoldenRecord[]>;
}

const FloorSchema = z.object({
  limit: z.number().int().positive(),
  lexico: z.record(z.string(), z.object({ hits: z.number().int().nonnegative() })),
  /** Off-topic questions allowed to bring anything back: a looser rescue must not slip past CI. */
  lexico_ajenas_max: z.number().int().nonnegative().optional(),
});

export type GoldenFloor = z.infer<typeof FloorSchema>;

function fail(where: string, message: string): never {
  throw new Error(`golden inválido en ${where}: ${message}`);
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "línea"}: ${issue.message}`)
    .join("; ");
}

/**
 * Validate the whole corpus before touching the DB: an `expect` naming a missing key is a
 * test that can never pass, and that must surface at load time, not in the metrics. Every
 * error carries the file name and the line.
 */
export function parseGolden(files: readonly GoldenFile[]): GoldenCorpus {
  const domains: Record<string, GoldenRecord[]> = {};
  const seen = new Map<string, string>();
  const memoryKeys = new Set<string>();
  const traits: Array<{ where: string; evidence: string[] }> = [];
  const queries: Array<{ where: string; kind: string; expect: string[] }> = [];

  for (const file of files) {
    const domain = basename(file.name).replace(/\.jsonl$/i, "");
    const records = domains[domain] ?? [];
    domains[domain] = records;

    file.text.split(/\r?\n/).forEach((line, index) => {
      if (!line.trim()) return;
      const where = `${file.name}:${index + 1}`;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch (err) {
        fail(where, `JSON inválido: ${(err as Error).message}`);
      }
      const parsed = GoldenLine.safeParse(raw);
      if (!parsed.success) fail(where, describeIssues(parsed.error));

      const data = parsed.data;
      const key = data.type === "query" ? data.id : data.key;
      const previous = seen.get(key);
      if (previous) fail(where, `clave duplicada: ${key} (ya está en ${previous})`);
      seen.set(key, where);

      if (data.type === "memory") memoryKeys.add(key);
      if (data.type === "trait") traits.push({ where, evidence: data.evidence });
      if (data.type === "query") queries.push({ where, kind: data.kind, expect: data.expect });
      records.push({ ...data, domain });
    });
  }

  for (const { where, evidence } of traits) {
    for (const key of evidence) {
      if (!memoryKeys.has(key)) fail(where, `la evidencia ${key} no es una memoria`);
    }
  }
  for (const { where, kind, expect } of queries) {
    if (kind === "ajena" && expect.length > 0) {
      fail(where, "una pregunta ajena no puede esperar claves");
    }
    if (kind !== "ajena" && expect.length === 0) {
      fail(where, `una pregunta ${kind} necesita al menos una clave esperada`);
    }
    for (const key of expect) {
      if (!seen.has(key)) fail(where, `la clave esperada ${key} no existe`);
    }
  }

  return { domains };
}

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

    // Second pass: evidence may point at a memory from another file.
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
        record.expect
          .map((key) => ids.get(key))
          .filter((id): id is string => id !== undefined),
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

/** CI floor per kind. An unknown kind is a typo, not a no-op. */
export function parseFloor(text: string): GoldenFloor {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`floor.json inválido: ${(err as Error).message}`);
  }
  const parsed = FloorSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`floor.json inválido: ${describeIssues(parsed.error)}`);
  for (const kind of Object.keys(parsed.data.lexico)) {
    if (!(GOLDEN_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`floor.json inválido: tipo desconocido: ${kind}`);
    }
  }
  return parsed.data;
}
