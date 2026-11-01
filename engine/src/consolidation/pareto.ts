// Pareto classifier inspired by PAMPAr-Coder: scores each episode [0,1] and buckets it L0..L3
// with no LLM and no DB, so it runs before the costly call. L0 is noise, a candidate for forget;
// L1..L3 are only a score today, since consolidation reads nothing but `level === 0`.
import { contentTerms } from "../domain/terms.js";

/** Content words from which a short text stops being filler. */
const MIN_FACT_TERMS = 3;

interface ParetoScores {
  density: number;
  novelty: number;
  loss_proxy: number;
  length_norm: number;
}

export interface ParetoResult {
  importance: number;
  level: 0 | 1 | 2 | 3;
  scores: ParetoScores;
}

export interface ClassifyOptions {
  /** The model's loss if available, in [0, 5+]. Default 0. */
  lossHint?: number;
  /** Neighbouring texts (same scope, recent) used to compute novelty. */
  neighbors?: string[];
}

const PAT_CODE = [
  /\bclass\s+\w+/g,
  /\b(def|function|fn|func)\s+\w+\s*\(/g,
  /@\w+/g,
  /\b(try|except|catch|throw|raise)\b/g,
  /:\s*\w+\s*[,)=]|->\s*\w+/g,
  /\[.*\bfor\b.*\bin\b.*\]/g,
  /\b(async|await|yield)\b/g,
  /\b(import|from|require|use)\b/g,
];

const PAT_DECISION = [
  /\b(decisi[oó]n|decision|chose|elegimos|bug|bugfix|fixed|fixé|root cause|tradeoff|aprend[ií])\b/gi,
  /\b(why|porque|because|evitar|avoid|never|nunca|always|siempre)\b/gi,
];

// A preference fits in few words and carries no technical patterns: without this,
// "I prefer Rust for the backend" landed in L0 and was discarded before the LLM.
const PAT_PREFERENCE = [
  /\b(prefiero|prefer[ií]|prefer|me gusta|odio|detesto|dej[eé] de|en vez de|instead of)\b/gi,
  /\b(uso|usamos|us[eé]|using|me quedo con|elijo|voy con|mejor que|worse than|better than)\b/gi,
];

/**
 * Pattern density per line for code, decision and preference patterns.
 * More advanced patterns means more concepts, so more value.
 */
function computeDensity(text: string): number {
  const lines = text.split(/\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return 0;

  let hits = 0;
  for (const p of PAT_CODE) {
    const m = text.match(p);
    if (m) hits += m.length;
  }
  for (const p of PAT_DECISION) {
    const m = text.match(p);
    if (m) hits += m.length;
  }
  for (const p of PAT_PREFERENCE) {
    const m = text.match(p);
    if (m) hits += m.length;
  }
  // Normalise: 8+ hits / 10 lines = maximum density
  return Math.min(1, hits / Math.max(1, lines.length) / 0.8);
}

/**
 * Novelty by n-gram overlap (word 3-grams).
 * No embeddings, so it is fast and offline.
 */
function computeNovelty(text: string, neighbors: string[]): number {
  if (neighbors.length === 0) return 1;
  const ngrams = (s: string): Set<string> => {
    const words = s.toLowerCase().match(/\w+/g) ?? [];
    const out = new Set<string>();
    for (let i = 0; i < words.length - 2; i++) {
      out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
    }
    return out;
  };

  const target = ngrams(text);
  if (target.size === 0) return 1;

  let maxOverlap = 0;
  for (const n of neighbors) {
    const other = ngrams(n);
    if (other.size === 0) continue;
    let common = 0;
    for (const g of target) if (other.has(g)) common++;
    const overlap = common / target.size;
    if (overlap > maxOverlap) maxOverlap = overlap;
  }
  return 1 - maxOverlap;
}

function computeLengthNorm(text: string): number {
  // 500+ chars = maximum. Penalises trivial fragments.
  return Math.min(1, text.length / 500);
}

function computeLossProxy(lossHint: number): number {
  // Typical loss: 0 to 5+. Normalise to [0,1]; >5 saturates.
  if (!Number.isFinite(lossHint) || lossHint <= 0) return 0;
  return Math.min(1, lossHint / 5);
}

function levelOf(importance: number): 0 | 1 | 2 | 3 {
  if (importance < 0.3) return 0;
  if (importance < 0.6) return 1;
  if (importance < 0.85) return 2;
  return 3;
}

export function classify(text: string, opts: ClassifyOptions = {}): ParetoResult {
  if (!text.trim()) {
    return {
      importance: 0,
      level: 0,
      scores: { density: 0, novelty: 0, loss_proxy: 0, length_norm: 0 },
    };
  }

  const density = computeDensity(text);
  const novelty = computeNovelty(text, opts.neighbors ?? []);
  const loss_proxy = computeLossProxy(opts.lossHint ?? 0);
  const length_norm = computeLengthNorm(text);

  // Trivial (short, no density) goes to L0 to avoid inflation from novelty=1. A short fact
  // still is data ("deploy takes 40 min", "use pnpm"): it reaches the LLM, since sending it
  // costs almost nothing and dropping it here deleted it unseen. A bare number is not a fact;
  // it only counts next to a word with no digits ("Node 24", "port 5000"), and the three
  // content words are counted without numbers ("1 2 3" is not a fact).
  const hasFigure = /\p{N}/u.test(text);
  const namedTerms = [...contentTerms(text)].filter((t) => !/\p{N}/u.test(t)).length;

  if (
    text.trim().length < 40 &&
    density === 0 &&
    loss_proxy === 0 &&
    namedTerms < MIN_FACT_TERMS &&
    !(hasFigure && namedTerms > 0)
  ) {
    return {
      importance: 0,
      level: 0,
      scores: { density, novelty, loss_proxy, length_norm },
    };
  }

  const importance = Math.min(
    1,
    Math.round(
      (0.35 * density + 0.30 * novelty + 0.25 * loss_proxy + 0.10 * length_norm) * 10000,
    ) / 10000,
  );

  return {
    importance,
    level: levelOf(importance),
    scores: { density, novelty, loss_proxy, length_norm },
  };
}
