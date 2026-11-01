/**
 * The golden corpus: Zod schemas, cross-reference check and CI floor. Format: docs/recall.md.
 */
import { basename } from "node:path";
import { z } from "zod";
import { Scope } from "../schema.js";

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
  // Query ids share the key space with records, but they are not answers: keeping them
  // apart lets the validator explain the difference instead of reporting a missing key.
  const recordKeys = new Set<string>();
  const queryIds = new Set<string>();
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

      if (data.type === "query") {
        queryIds.add(key);
        queries.push({ where, kind: data.kind, expect: data.expect });
      } else {
        recordKeys.add(key);
        if (data.type === "trait") traits.push({ where, evidence: data.evidence });
      }
      records.push({ ...data, domain });
    });
  }

  for (const { where, evidence } of traits) {
    for (const key of evidence) {
      if (queryIds.has(key)) {
        fail(where, `la evidencia ${key} es un id de pregunta, no una memoria, un episodio ni un rasgo`);
      }
      if (!recordKeys.has(key)) fail(where, `la evidencia ${key} no existe`);
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
      if (queryIds.has(key)) {
        fail(where, `la clave esperada ${key} es un id de pregunta, no una memoria, un episodio ni un rasgo`);
      }
      if (!recordKeys.has(key)) fail(where, `la clave esperada ${key} no existe`);
    }
  }

  return { domains };
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
