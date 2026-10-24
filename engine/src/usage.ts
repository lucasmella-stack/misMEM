/**
 * Qué recuerdos usó de verdad una respuesta, leído del transcript de Claude Code.
 *
 * El recall devuelve varios y el modelo usa uno o ninguno: reforzar todo lo devuelto
 * premia al que siempre aparece y nunca sirve. Acá la señal es el solapamiento de
 * palabras distintivas entre el recuerdo y la respuesta. Es una aproximación —una
 * paráfrasis sin palabras compartidas no se detecta— pero falla hacia no reforzar,
 * que es el lado barato: un recuerdo útil que no suma saliencia sigue encontrándose.
 */
import { parseInjection } from "./inject.js";
import { contentTerms } from "./terms.js";

export interface RecalledMemory {
  id: string;
  text: string;
}

export interface UsageOptions {
  /** Fracción de las palabras distintivas del recuerdo que la respuesta tiene que repetir. */
  minOverlap?: number;
  /** Piso absoluto: con pocas palabras compartidas el solapamiento alto es casualidad. */
  minShared?: number;
}

// Calibrado sobre 573 recuerdos devueltos en turnos reales con recall: la mediana de
// solapamiento es 0,07 y el percentil 90 es 0,25. Con estos umbrales cuenta como usado
// el 9 %, más o menos uno por llamada a recall; con 0,30/4 baja al 4 %.
export const DEFAULT_MIN_OVERLAP = 0.2;
export const DEFAULT_MIN_SHARED = 3;

interface Block {
  type?: string;
  text?: string;
  content?: unknown;
}

function blocksOf(line: unknown): Block[] {
  const message = (line as { message?: { content?: unknown } } | null)?.message;
  return Array.isArray(message?.content) ? (message.content as Block[]) : [];
}

function textOf(line: unknown): string {
  return blocksOf(line)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

function roleOf(line: unknown): string | undefined {
  return (line as { type?: string } | null)?.type;
}

/**
 * El último turno: desde el último mensaje escrito por la persona hasta el final.
 * Un mensaje de usuario que sólo transporta `tool_result` no abre un turno nuevo.
 */
export function lastTurn(lines: readonly unknown[]): unknown[] {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (roleOf(lines[i]) !== "user") continue;
    const blocks = blocksOf(lines[i]);
    const carriesToolResult = blocks.some((b) => b.type === "tool_result");
    const typed =
      typeof (lines[i] as { message?: { content?: unknown } }).message?.content === "string" ||
      blocks.some((b) => b.type === "text");
    if (typed && !carriesToolResult) return lines.slice(i);
  }
  return [...lines];
}

/** Los recuerdos que `recall` devolvió dentro de estas líneas. */
export function recalledMemories(lines: readonly unknown[]): RecalledMemory[] {
  const out = new Map<string, RecalledMemory>();
  for (const line of lines) {
    for (const block of blocksOf(line)) {
      if (block.type !== "tool_result") continue;
      const raw = block.content;
      const payload = Array.isArray(raw)
        ? (raw as Block[])
            .filter((b) => b.type === "text" && typeof b.text === "string")
            .map((b) => b.text as string)
            .join("")
        : typeof raw === "string"
          ? raw
          : "";
      if (!payload.includes('"hits"')) continue;
      let parsed: { hits?: Array<{ layer?: string; id?: string; text?: string }> };
      try {
        parsed = JSON.parse(payload) as typeof parsed;
      } catch {
        continue;
      }
      for (const hit of parsed.hits ?? []) {
        if (hit.layer !== "memory" || !hit.id || !hit.text) continue;
        out.set(hit.id, { id: hit.id, text: hit.text });
      }
    }
  }
  return [...out.values()];
}

/**
 * Los recuerdos que el hook de inyección puso en el contexto dentro de estas líneas. Claude
 * Code guarda su `additionalContext` como un adjunto `hook_additional_context`, no como un
 * `tool_result`, así que `recalledMemories` no los ve y nunca se reforzaban.
 */
export function injectedMemories(lines: readonly unknown[]): RecalledMemory[] {
  const out = new Map<string, RecalledMemory>();
  for (const line of lines) {
    const attachment = (line as { type?: string; attachment?: { type?: string; content?: unknown } } | null)
      ?.attachment;
    if (roleOf(line) !== "attachment" || attachment?.type !== "hook_additional_context") continue;
    const content = attachment.content;
    const texts = Array.isArray(content) ? content : [content];
    for (const text of texts) {
      if (typeof text !== "string") continue;
      for (const { id, text: memoryText } of parseInjection(text)) out.set(id, { id, text: memoryText });
    }
  }
  return [...out.values()];
}

/** Lo que el asistente escribió para la persona, sin los resultados de herramientas. */
export function assistantReply(lines: readonly unknown[]): string {
  return lines
    .filter((line) => roleOf(line) === "assistant")
    .map(textOf)
    .filter(Boolean)
    .join("\n");
}

export function overlap(memoryText: string, reply: string): { shared: number; fraction: number } {
  const terms = contentTerms(memoryText);
  if (terms.size === 0) return { shared: 0, fraction: 0 };
  const replyTerms = contentTerms(reply);
  let shared = 0;
  for (const term of terms) if (replyTerms.has(term)) shared++;
  return { shared, fraction: shared / terms.size };
}

export function usedMemoryIds(
  memories: readonly RecalledMemory[],
  reply: string,
  opts: UsageOptions = {},
): string[] {
  const minOverlap = opts.minOverlap ?? DEFAULT_MIN_OVERLAP;
  const minShared = opts.minShared ?? DEFAULT_MIN_SHARED;
  if (!reply.trim()) return [];
  return memories
    .filter((memory) => {
      const { shared, fraction } = overlap(memory.text, reply);
      return shared >= minShared && fraction >= minOverlap;
    })
    .map((memory) => memory.id);
}
