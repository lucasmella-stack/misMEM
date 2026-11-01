// Owns the lax rescue: its prefix, rarity and minimum-match constants and the scoring that
// decides which candidates survive when the strict query found nothing.
import type { Database as DB } from "better-sqlite3";
import { plain, searchTerms } from "../domain/terms.js";
import { excludeNoiseSql } from "../store/rows.js";
import { FTS_TOKEN_SPLIT, quoteFts } from "./fts.js";
import type { RankedCandidate } from "./lexical.js";

// The tokenizer does not stem: without this "controlo" misses "controlan" and "deudas"
// misses "deuda". A word of five letters or more searches by its start minus the last three
// letters (where gender, number and conjugation change), never by fewer than four.
const PREFIX_FROM_LENGTH = 5;
const PREFIX_TRIM = 3;
const PREFIX_MIN = 4;

// How many distinct informative terms must match. One would let in any memory sharing a
// rare but unrelated word; two force the candidate to talk about the same thing twice, and
// common words do not count.
const RELAXED_MIN_INFORMATIVE = 2;
// In a long question two matches prove nothing even if rare, so the ratio raises the
// minimum with the size of the query. It is measured over every searched word, not only the
// informative ones: in a tiny corpus almost everything looks rare, and two common words
// rescued an unrelated long question (the astronomy case in the tests).
// Informative terms still drive the match count and the order; this only sets the bar.
const RELAXED_MIN_RATIO = 0.3;
// A term is rare when it appears in few memories; one that appears in many does not tell a
// paraphrase from a coincidence (bm25's IDF idea). The floor of 3 documents protects small
// corpora and the fraction grows with the base, so "few" means the same at 300 memories and
// at 3,000. Calibrated with `mismem-bench --off-topic`: docs/recall.md#el-rescate.
const RELAXED_RARE_MIN_DOCS = 3;
const RELAXED_RARE_FRACTION = 0.05;
// Rescue is a last resort, not a second list: three memories recover the paraphrase without
// turning the answer into a dump. This is the rescue's only cap; the strict path keeps its
// own candidate pool.
const RELAXED_MAX_RESULTS = 3;
// Word cap so the rescue query does not grow without bound.
export const RELAXED_MAX_TERMS = 12;

export interface RelaxedTerm {
  word: string;
  /** The start it searches by; null when the word is too short and goes exact. */
  prefix: string | null;
}

interface RelaxedQuery {
  /** Terms searched and counted, with repeated prefixes already merged. */
  terms: RelaxedTerm[];
  /** Distinct words before merging prefixes: tells whether the query is a single one. */
  wordCount: number;
}

/**
 * The rescue words, normalized and deduplicated. The approximate stem uses the prefix-search
 * constants, because the last three letters are where gender, number and conjugation change;
 * each word splits like the FTS5 side, since `a_b` is two tokens for the index and one here.
 */
export function relaxedTerms(query: string): RelaxedQuery {
  const seen = new Set<string>();
  const terms: RelaxedTerm[] = [];
  for (const term of searchTerms(query)) {
    for (const word of plain(term).split(FTS_TOKEN_SPLIT)) {
      if (!word || seen.has(word)) continue;
      seen.add(word);
      terms.push({
        word,
        prefix:
          word.length < PREFIX_FROM_LENGTH
            ? null
            : word.slice(0, Math.max(PREFIX_MIN, word.length - PREFIX_TRIM)),
      });
    }
  }
  return {
    terms: dedupeByPrefix(terms).slice(0, RELAXED_MAX_TERMS),
    wordCount: terms.length,
  };
}

/**
 * Merges the terms that search by the same start: `decidir` (`deci`) and `decision` (`decis`)
 * are satisfied by the same token, so keeping both would reach the minimum of two matches with
 * one word. The longest prefix wins: most specific, fewest foreign candidates.
 */
function dedupeByPrefix(terms: RelaxedTerm[]): RelaxedTerm[] {
  const kept: RelaxedTerm[] = [];
  const prefixes: string[] = [];
  for (const term of terms) {
    const prefix = term.prefix ?? term.word;
    const clash = prefixes.findIndex(
      (other) => prefix.startsWith(other) || other.startsWith(prefix),
    );
    if (clash === -1) {
      kept.push(term);
      prefixes.push(prefix);
    } else if (prefix.length > (prefixes[clash]?.length ?? 0)) {
      kept[clash] = term;
      prefixes[clash] = prefix;
    }
  }
  return kept;
}

/**
 * The rescue query when the strict one found nothing: one expression ORing every word.
 * FTS5 no longer decides whether the memory qualifies; it only brings cheap candidates.
 */
export function relaxedFts(terms: RelaxedTerm[]): string {
  const expressions = terms.map(({ word, prefix }) =>
    prefix ? `${quoteFts(prefix)}*` : quoteFts(word),
  );
  return expressions.join(" OR ") || '""';
}

// In how many distinct memories the term appears, with rescue's prefix. Measured on
// `memories_fts` and not on the rescued layer: memories are where generic vocabulary piles
// up, while traits and episodes are sparse and would make almost anything look rare.
// Unscoped, because the vocabulary is the person's, and free of noise like the search.
function documentFrequency(db: DB, term: RelaxedTerm): number {
  const q = term.prefix ? `${quoteFts(term.prefix)}*` : quoteFts(term.word);
  const row = db
    .prepare(
      `SELECT count(*) AS n
       FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
       WHERE memories_fts MATCH ? AND ${excludeNoiseSql("m")}`,
    )
    .get(q) as { n: number };
  return row.n;
}

// The terms that tell things apart. An absent term scores 0, the rarest value, and is kept: it
// cannot match a memory but can match an episode or trait (a new install has no memories).
// The price, however big the base: an episode sharing two absent words with an unrelated
// question ("cambiar la configuración del móvil" vs the server's) is rescued anyway, and only
// words common in the memories, above `rare`, stop it. A term in every memory is the topic.
export function informativeTerms(db: DB, terms: RelaxedTerm[]): RelaxedTerm[] {
  const total = (
    db
      .prepare(
        `SELECT count(*) AS n
         FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
         WHERE ${excludeNoiseSql("m")}`,
      )
      .get() as { n: number }
  ).n;
  const rare = Math.max(RELAXED_RARE_MIN_DOCS, Math.ceil(total * RELAXED_RARE_FRACTION));
  return terms.filter((term) => {
    const frequency = documentFrequency(db, term);
    return frequency <= rare || frequency === total;
  });
}

// How many of the query's distinct informative terms appear in the text, counted by the
// same prefix that was searched; common words do not count, and tokens split like FTS5
// (underscore included), or `columna_beta` would not match `beta`. A token shorter than the
// prefix length never matches by prefix: "solar" trims to "sola", and "una sola pasada"
// rescued an unrelated question without that guard. The plural of a four-letter singular is lost either way.
function countRelaxedMatches(text: string, terms: RelaxedTerm[]): number {
  const tokens = plain(text)
    .split(FTS_TOKEN_SPLIT)
    .filter(Boolean);
  return terms.reduce((count, { word, prefix }) => {
    const found = tokens.some((token) =>
      prefix
        ? token.length >= PREFIX_FROM_LENGTH && token.startsWith(prefix)
        : token === word,
    );
    return found ? count + 1 : count;
  }, 0);
}

/**
 * Keeps only the rescue candidates that reach the minimum of informative terms and orders
 * them by those matches, not by salience or age. The cap stops the rescue from becoming a
 * second list.
 */
export function relaxRows<T extends RankedCandidate>(
  rows: T[],
  informative: RelaxedTerm[],
  queryWords: number,
): T[] {
  if (rows.length === 0 || informative.length === 0) return [];
  // A single-word query cannot gather two matches: if rescue got here the prefix changed
  // the query, and the prefix already requires PREFIX_FROM_LENGTH letters, so a short word
  // goes exact and is never rescued. In the rest, the ratio raises the minimum with its size.
  const required =
    queryWords === 1
      ? 1
      : Math.max(RELAXED_MIN_INFORMATIVE, Math.ceil(queryWords * RELAXED_MIN_RATIO));
  // If there are not as many informative terms as the query requires, nobody can qualify.
  if (informative.length < required) return [];
  return rows
    .map((row) => ({
      row,
      matches: countRelaxedMatches(row.search_text ?? row.text, informative),
    }))
    .filter(({ matches }) => matches >= required)
    .sort(
      (a, b) =>
        b.matches - a.matches ||
        Number(a.row.fts_rank) - Number(b.row.fts_rank) ||
        a.row.id.localeCompare(b.row.id),
    )
    .slice(0, RELAXED_MAX_RESULTS)
    .map(({ row }) => row);
}
