// The connectome: memory's lateral layer, pairing the memories one turn used together.
// The weight is NPMI, not a raw count: see `docs/architecture.md#el-índice-hebbiano`.
// `origin` and `evidence` stay vertical: episode -> memory -> trait.
import type { Database as DB } from "better-sqlite3";
import { supportConfidence } from "../domain/support.js";

const TURNS_KEY = "connectome.turns";

export interface CoUseEdge {
  last_at: number;
  memory_a: string;
  memory_b: string;
  /** Turns the pair was used together. The support: strength means nothing without it. */
  n: number;
  /** NPMI, in [-1, 1]. */
  strength: number;
}

export interface Hub {
  /** Neighbours above the support floor, unweighted: a popularity count. */
  degree: number;
  id: string;
  /** Sum of the positive associations. This is what orders hubs, not degree. */
  strength: number;
  /**
   * Turns behind its best edge. NPMI scores 1 both for "always together" and for "once, and
   * that was the only turn either appeared in", so the sum above does not read without this.
   */
  support: number;
}

export interface EdgeQuery {
  /** Restrict to this set: an edge to a node nobody draws is a dangling reference. */
  ids?: readonly string[];
  /** Minimum support, in turns. Defaults to 1: return everything, decide outside. */
  minN?: number;
}

/**
 * Turns of measured use on record. This is the denominator: without it there is no
 * way to tell whether a pair shows up together more often than chance does.
 */
export function turnsRegistered(db: DB): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(TURNS_KEY) as
    | { value: string }
    | undefined;
  const n = Number(row?.value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Adds one turn. Called by `reinforce`, never by the recall path. */
export function registerTurn(db: DB): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, '1')
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
  ).run(TURNS_KEY);
}

/**
 * Puts the counter on the same clock as the counts it divides: a DB written before it carries
 * `n` and `use_count` from uncounted turns, and a zero denominator clamps every pair to a maximal
 * association. Seeds with the highest use on record, only when the counter is absent.
 */
export function seedTurnsFromUse(db: DB): void {
  const existing = db.prepare("SELECT 1 FROM meta WHERE key = ?").get(TURNS_KEY);
  if (existing !== undefined) return;

  const row = db
    .prepare(
      `SELECT MAX(bound) AS bound FROM (
         SELECT MAX(use_count) AS bound FROM memories
         UNION ALL
         SELECT MAX(n) AS bound FROM co_use
       )`,
    )
    .get() as { bound: number | null };
  const turns = row.bound ?? 0;
  if (turns <= 0) return;

  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(TURNS_KEY, String(turns));
}

/**
 * NPMI for the pair. Returns 0 — "unknown" — rather than an invented number when
 * the denominator is missing or either side records no use.
 */
export function associationStrength(args: {
  n: number;
  turns: number;
  useA: number;
  useB: number;
}): number {
  const { n, turns, useA, useB } = args;
  if (turns <= 0 || n <= 0 || useA <= 0 || useB <= 0) return 0;

  const pab = Math.min(n / turns, 1);
  const pa = Math.min(useA / turns, 1);
  const pb = Math.min(useB / turns, 1);
  // Together in every turn: the denominator vanishes and the limit is 1.
  if (pab >= 1) return 1;

  const npmi = Math.log(pab / (pa * pb)) / -Math.log(pab);
  if (!Number.isFinite(npmi)) return 0;
  return Math.max(-1, Math.min(1, npmi));
}

interface RawEdge {
  last_at: number;
  memory_a: string;
  memory_b: string;
  n: number;
  use_a: number;
  use_b: number;
}

function rawEdges(db: DB, query: EdgeQuery): RawEdge[] {
  const minN = Math.max(1, query.minN ?? 1);
  const scoped = query.ids !== undefined;
  return db
    .prepare(
      `SELECT c.memory_a, c.memory_b, c.n, c.last_at, a.use_count AS use_a, b.use_count AS use_b
       FROM co_use c
       JOIN memories a ON a.id = c.memory_a
       JOIN memories b ON b.id = c.memory_b
       WHERE c.n >= @minN
         AND (@scoped = 0 OR (
           c.memory_a IN (SELECT value FROM json_each(@ids))
           AND c.memory_b IN (SELECT value FROM json_each(@ids))
         ))`,
    )
    .all({
      ids: JSON.stringify(scoped ? [...new Set(query.ids)] : []),
      minN,
      scoped: scoped ? 1 : 0,
    }) as RawEdge[];
}

/** Lateral edges, most associated first. */
export function coUseEdges(db: DB, query: EdgeQuery = {}): CoUseEdge[] {
  const turns = turnsRegistered(db);
  return rawEdges(db, query)
    .map((r) => ({
      last_at: r.last_at,
      memory_a: r.memory_a,
      memory_b: r.memory_b,
      n: r.n,
      strength: associationStrength({ n: r.n, turns, useA: r.use_a, useB: r.use_b }),
    }))
    .sort((x, y) => y.strength - x.strength || y.n - x.n);
}

/**
 * The nodes worth entering through. Orders by accumulated association and not by
 * degree, which is the difference between a hub and the most popular memory.
 */
export function hubs(db: DB, query: EdgeQuery = {}): Hub[] {
  const acc = new Map<string, Hub>();
  const bump = (id: string, strength: number, n: number): void => {
    const current = acc.get(id) ?? { degree: 0, id, strength: 0, support: 0 };
    current.degree += 1;
    // Weighted by support: unweighted, a node with three pairs seen once each outranks a pair
    // that actually repeated, which is popularity wearing the name of association.
    if (strength > 0) current.strength += strength * supportConfidence(n);
    current.support = Math.max(current.support, n);
    acc.set(id, current);
  };

  for (const edge of coUseEdges(db, query)) {
    bump(edge.memory_a, edge.strength, edge.n);
    bump(edge.memory_b, edge.strength, edge.n);
  }

  return [...acc.values()].sort((x, y) => y.strength - x.strength || y.degree - x.degree);
}
