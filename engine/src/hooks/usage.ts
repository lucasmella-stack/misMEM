// Which memories an answer really used, read from the Claude Code transcript. Reinforcing
// everything recall returned would reward what always shows up, so the signal is the overlap of
// distinctive words; it errs towards not reinforcing, the cheap side.
import { parseInjection } from "./inject.js";
import { contentTerms } from "../domain/terms.js";

export interface RecalledMemory {
  id: string;
  text: string;
}

export interface UsageOptions {
  /** Fraction of the memory's distinctive words the answer has to repeat. */
  minOverlap?: number;
  /** Absolute floor: with few shared words a high overlap is chance. */
  minShared?: number;
}

// Calibrated on 573 memories returned in real turns: the median overlap is 0.07 and the 90th
// percentile 0.25. These thresholds count 9% as used, about one per recall call; 0.30/4 drops
// it to 4%.
const DEFAULT_MIN_OVERLAP = 0.2;
const DEFAULT_MIN_SHARED = 3;

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
 * The last turn: from the last message the person wrote to the end. A user message that only
 * carries a `tool_result` does not open a new turn.
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

/** The memories `recall` returned inside these lines. */
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
 * The memories the injection hook put in the context inside these lines. Claude Code stores its
 * `additionalContext` as a `hook_additional_context` attachment, not a `tool_result`, so
 * `recalledMemories` does not see them.
 */
export function injectedMemories(lines: readonly unknown[]): RecalledMemory[] {
  const out = new Map<string, RecalledMemory>();
  for (const line of lines) {
    const attachment = (
      line as { type?: string; attachment?: { type?: string; content?: unknown } } | null
    )?.attachment;
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

/** What the assistant wrote to the person, without the tool results. */
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
