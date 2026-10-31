// Which memories are worth putting in front of the model before it answers. The model does not
// always ask for what it needs, but injecting every turn costs tokens and adds noise: few
// memories, none from a scope the user keeps private, and nothing the context already holds.
import type { RecallHit } from "../schema.js";
import { contentTerms } from "../domain/terms.js";

interface InjectOptions {
  maxMemories?: number;
  maxChars?: number;
  minPromptTerms?: number;
  /** Scope prefixes that do not travel: personal notes must not enter a prompt bound for the cloud. */
  excludeScopes?: readonly string[];
  /** Ids the context already holds: repeating them pays twice. */
  alreadyPresent?: ReadonlySet<string>;
}

export const DEFAULT_MAX_MEMORIES = 3;
export const DEFAULT_MAX_CHARS = 1200;
// "dale", "ok", "y eso?" have nothing to search yet cost the same; with 3 this also dropped
// "deploy florfitt", a short but legitimate question.
export const DEFAULT_MIN_PROMPT_TERMS = 2;

/** A prompt without substantive words does not justify a search. */
export function worthRecalling(prompt: string, minTerms = DEFAULT_MIN_PROMPT_TERMS): boolean {
  return contentTerms(prompt).size >= minTerms;
}

/** `lucas` covers `lucas/profile` but not `lucas-publico`. */
export function inExcludedScope(scope: string, excluded: readonly string[]): boolean {
  return excluded.some((prefix) => scope === prefix || scope.startsWith(`${prefix}/`));
}

export function parseScopeList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Episodes stay out on purpose: they are verbatim, noisy and `forget` removes them. What is
 * worth bringing forward is memories and traits.
 */
export function selectForInjection(
  hits: readonly RecallHit[],
  opts: InjectOptions = {},
): RecallHit[] {
  const maxMemories = opts.maxMemories ?? DEFAULT_MAX_MEMORIES;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const excluded = opts.excludeScopes ?? [];
  const present = opts.alreadyPresent ?? new Set<string>();

  const out: RecallHit[] = [];
  let used = 0;
  for (const hit of hits) {
    if (out.length >= maxMemories) break;
    if (hit.layer === "episode") continue;
    if (present.has(hit.id)) continue;
    if (inExcludedScope(hit.scope, excluded)) continue;
    if (used + hit.text.length > maxChars) continue;
    out.push(hit);
    used += hit.text.length;
  }
  return out;
}

/** The block's first line: it identifies a misMEM injection in a transcript. */
const INJECTION_HEADER =
  "Recuerdos de misMEM que pueden venir al caso. Son notas guardadas de antes, no algo";

/** Makes clear these are old notes, not something the person just said. */
export function formatInjection(hits: readonly RecallHit[]): string {
  if (hits.length === 0) return "";
  const lines = hits.map((hit) => `- [${hit.id}] ${hit.scope} — ${hit.text}`);
  return [
    INJECTION_HEADER,
    "que la persona acaba de decir: usalos si ayudan y no se los atribuyas a ella.",
    ...lines,
  ].join("\n");
}

interface InjectedLine {
  id: string;
  scope: string;
  text: string;
}

const INJECTED_LINE = /^- \[([^\]]+)\] (.*?) — (.*)$/;

/**
 * The inverse of `formatInjection`, so the reinforcement hook sees what was injected. It lives
 * next to the format on purpose: if one changes without the other, what was injected stops
 * being reinforced with nothing failing. Text without the misMEM header contributes nothing.
 */
export function parseInjection(text: string): InjectedLine[] {
  if (!text.includes(INJECTION_HEADER)) return [];
  return text.split("\n").flatMap((line) => {
    const [, id, scope, contenido] = INJECTED_LINE.exec(line) ?? [];
    return id && scope !== undefined && contenido !== undefined
      ? [{ id, scope, text: contenido }]
      : [];
  });
}
