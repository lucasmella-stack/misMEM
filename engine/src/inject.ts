/**
 * Qué recuerdos vale la pena poner delante del modelo antes de que responda.
 *
 * El modelo no siempre pide lo que necesita: si no llama a `recall`, no recuerda.
 * Pero inyectar en cada turno cuesta tokens y mete ruido, así que acá se decide
 * poco y con criterio: una pregunta con sustancia, pocos recuerdos, ninguno de un
 * ámbito que el usuario no quiere mandar afuera, y nada que ya esté en el contexto.
 */
import type { RecallHit } from "./schema.js";
import { contentTerms } from "./terms.js";

export interface InjectOptions {
  maxMemories?: number;
  maxChars?: number;
  minPromptTerms?: number;
  /** Prefijos de ámbito que no viajan: lo personal no entra a un prompt que va a la nube. */
  excludeScopes?: readonly string[];
  /** Ids que el contexto ya tiene: repetirlos es pagar dos veces. */
  alreadyPresent?: ReadonlySet<string>;
}

export const DEFAULT_MAX_MEMORIES = 3;
export const DEFAULT_MAX_CHARS = 1200;
// "dale", "ok", "y eso?" no tienen nada que buscar y la llamada se paga igual. Con 3
// se caía también "deploy florfitt", que es una pregunta corta pero legítima.
export const DEFAULT_MIN_PROMPT_TERMS = 2;

/** Un prompt sin palabras con sustancia no justifica una búsqueda. */
export function worthRecalling(prompt: string, minTerms = DEFAULT_MIN_PROMPT_TERMS): boolean {
  return contentTerms(prompt).size >= minTerms;
}

/** `lucas` tapa `lucas/profile`, pero no `lucas-publico`. */
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
 * Los episodios quedan afuera a propósito: son verbatim, ruidosos y `forget` los
 * borra. Lo que vale la pena adelantar son memorias y rasgos.
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

/** Primera línea del bloque: es lo que identifica la inyección de misMEM en un transcript. */
export const INJECTION_HEADER =
  "Recuerdos de misMEM que pueden venir al caso. Son notas guardadas de antes, no algo";

/** Deja claro que son notas viejas y no algo que la persona acabe de decir. */
export function formatInjection(hits: readonly RecallHit[]): string {
  if (hits.length === 0) return "";
  const lines = hits.map((hit) => `- [${hit.id}] ${hit.scope} — ${hit.text}`);
  return [
    INJECTION_HEADER,
    "que la persona acaba de decir: usalos si ayudan y no se los atribuyas a ella.",
    ...lines,
  ].join("\n");
}

export interface InjectedLine {
  id: string;
  scope: string;
  text: string;
}

const INJECTED_LINE = /^- \[([^\]]+)\] (.*?) — (.*)$/;

/**
 * Lo inverso de `formatInjection`, para que el hook de refuerzo vea qué se inyectó. Vive al
 * lado del formato a propósito: si uno cambia sin el otro, lo inyectado deja de reforzarse
 * sin que nada falle. Un texto sin la cabecera de misMEM no aporta nada.
 */
export function parseInjection(text: string): InjectedLine[] {
  if (!text.includes(INJECTION_HEADER)) return [];
  return text.split("\n").flatMap((line) => {
    const [, id, scope, text] = INJECTED_LINE.exec(line) ?? [];
    return id && scope !== undefined && text !== undefined ? [{ id, scope, text }] : [];
  });
}
