// Owns the lax rescue: its prefix, rarity and minimum-match constants and the scoring that
// decides which candidates survive when the strict query found nothing.
import type { Database as DB } from "better-sqlite3";
import { isRescueStopword, plain, searchTerms } from "../domain/terms.js";
import { excludeNoiseSql } from "../store/rows.js";
import { FTS_TOKEN_SPLIT, quoteFts } from "./fts.js";
import type { RankedCandidate } from "./lexical.js";

// The tokenizer does not stem: without this "controlo" misses "controlan" and "deudas"
// misses "deuda". A word of five letters or more searches by its start minus the last three
// letters (where gender, number and conjugation change), never by fewer than four.
const PREFIX_FROM_LENGTH = 5;
const PREFIX_TRIM = 3;
const PREFIX_MIN = 4;

// How many matching words a rescued record needs. One is too easy: any record sharing a
// rare but unrelated word would come back. The exception is a one-word query, which cannot
// reach two. The rescue sees at most RELAXED_MAX_TERMS words, so a bar that grew with the
// query would stop growing at twelve and change silently if that cap moved; two is what
// the golden corpus supports.
const RELAXED_MIN_INFORMATIVE = 2;
// A query is mostly made of words no record contains when it is about something else. In
// that case the few words that do exist are not evidence: the astronomy question of the
// unit test keeps only "sistema" out of seven content words. Requiring 30 % of the query
// words (stopwords excluded, before the term cap) to exist keeps it out, while a real long
// question leaves most of its words in the corpus.
const RELAXED_MIN_PRESENT_RATIO = 0.3;
// A record matched only by generic words proves nothing, so at least one rare word is
// required. Two made no difference to off-topic questions once the added function words
// were stopwords (measured before the presence gate, which later brought them to 4/48), but cost two colloquial questions and nine
// questions overall on the golden corpus, so one stays.
const RELAXED_MIN_RARE_MATCHES = 1;
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
const RELAXED_MAX_TERMS = 12;

export interface RelaxedTerm {
  word: string;
  /** The start it searches by; null when the word is too short and goes exact. */
  prefix: string | null;
}

interface RelaxedQuery {
  /** Terms searched and counted, with repeated prefixes already merged. */
  terms: RelaxedTerm[];
  /** Distinct words before merging prefixes and before the term cap: it says whether the
   * query has a single word, and it is the denominator of the presence gate, which is
   * measured over the whole question and not over what the rescue actually searches. */
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
      // The rescue drops filler the strict query keeps, through its own list: the strict
      // AND needs those words to match when they are the whole query, but an OR over them
      // only adds candidates that share nothing.
      if (!word || seen.has(word) || isRescueStopword(word)) continue;
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

/**
 * A query word with its weight. Frequency is measured over memories, so 0 means "no memory
 * has it": it may still live in a trait or a pending episode, which is why presence is also
 * checked against the candidates.
 */
interface PlannedTerm {
  term: RelaxedTerm;
  /** Memories where the term appears; 0 means it may still live in traits or episodes. */
  frequency: number;
  /** Surfaces rarer words first when ordering the rescue; log(1 + N / (1 + df)). */
  idf: number;
  /** Rare enough to tell records apart, or present in every memory (tiny corpus topic). */
  informative: boolean;
}

/**
 * What the rescue may demand from this query. `wordCount` counts the content words of the
 * whole question, before the cap; `terms` keeps only those a candidate contains, because
 * words no record has are context and inflated the required coincidences.
 */
export interface RelaxedPlan {
  terms: PlannedTerm[];
  /** Content words of the question, without the rescue's term cap. */
  wordCount: number;
}

/**
 * One pass of document frequencies per query term: it decides rarity and which words exist
 * at all, so a long question stops paying for names and filler no record contains. Total
 * and frequency share the same noise-filtered set.
 */
export function planTerms(
  db: DB,
  terms: readonly RelaxedTerm[],
  wordCount: number,
  rows: readonly RankedCandidate[],
): RelaxedPlan {
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
  const candidateTokens = rows.map((row) => tokensOf(row.search_text ?? row.text));
  const planned: PlannedTerm[] = [];
  for (const term of terms) {
    const frequency = documentFrequency(db, term);
    const inCandidates = candidateTokens.some((tokens) => termInTokens(tokens, term));
    // A word that is neither in the memories nor in any candidate cannot match anything;
    // keeping it only inflated the required number of coincidences.
    if (frequency === 0 && !inCandidates) continue;
    planned.push({
      term,
      frequency,
      idf: Math.log(1 + total / (1 + frequency)),
      // A term present in every memory is the corpus topic, not noise, and a term absent
      // from the memories may still distinguish an episode or a trait.
      informative: frequency <= rare || frequency === total,
    });
  }
  return { terms: planned, wordCount };
}

/** FTS5 splits on every non-letter, including `_`; the rescue has to count the same way. */
function tokensOf(text: string): string[] {
  return plain(text)
    .split(FTS_TOKEN_SPLIT)
    .filter(Boolean);
}

/**
 * Whether a token satisfies a query term. A token shorter than PREFIX_FROM_LENGTH cannot
 * match by prefix: "solar" trims to "sola", and without the guard any four-letter word
 * counted as an inflection, rescuing an unrelated question ("una sola pasada").
 */
function termInTokens(tokens: readonly string[], { word, prefix }: RelaxedTerm): boolean {
  return tokens.some((token) =>
    prefix
      ? token.length >= PREFIX_FROM_LENGTH && token.startsWith(prefix)
      : token === word,
  );
}

/**
 * Keeps only rescued candidates that clear the bar and orders them by how much they
 * explain the question, not by salience or age. The cap keeps the rescue a last resort
 * instead of a second result list.
 */
export function relaxRows<T extends RankedCandidate>(rows: T[], plan: RelaxedPlan): T[] {
  if (rows.length === 0) return [];
  const terms = plan.terms;
  if (terms.length === 0 || !terms.some(({ informative }) => informative)) return [];
  // If most of the question is about things no record contains, the few words that do
  // exist are not evidence; this keeps a long off-topic question from being rescued by two
  // generic words while a real long question still passes with most of its words present.
  if (terms.length / plan.wordCount < RELAXED_MIN_PRESENT_RATIO) return [];
  // A one-word query cannot reach two matches; anything else asks for two. The exception
  // is the original query having one word, not the plan keeping one term: two forms of the
  // same word dedupe to a single prefix and must still count as one coincidence, or
  // "decidir decision" rescues a memory that only says "decision".
  const singleWord = plan.wordCount === 1;
  const required = singleWord ? 1 : RELAXED_MIN_INFORMATIVE;
  // A one-word query has only one term to match, so asking for two rare ones would make
  // the rescue unreachable ("deudas" against "la deuda").
  const rareRequired = singleWord ? 1 : RELAXED_MIN_RARE_MATCHES;
  return rows
    .map((row) => {
      const tokens = tokensOf(row.search_text ?? row.text);
      const matched = terms.filter(({ term }) => termInTokens(tokens, term));
      return {
        row,
        matches: matched.length,
        informative: matched.filter(({ informative }) => informative).length,
        weight: matched.reduce((sum, { idf }) => sum + idf, 0),
      };
    })
    // A candidate made only of common words proves nothing; one rare word is the minimum
    // signal, and the count of all matches still has to clear two.
    .filter(
      ({ matches, informative }) => matches >= required && informative >= rareRequired,
    )
    .sort(
      (a, b) =>
        b.weight - a.weight ||
        b.informative - a.informative ||
        b.matches - a.matches ||
        Number(a.row.fts_rank) - Number(b.row.fts_rank) ||
        a.row.id.localeCompare(b.row.id),
    )
    .slice(0, RELAXED_MAX_RESULTS)
    .map(({ row }) => row);
}
