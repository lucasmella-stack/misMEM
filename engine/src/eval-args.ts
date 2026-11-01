/** Arguments and output lines for the golden eval CLI, apart from the CLI because it runs on import. */
import { ArgsError, flagNumber, flagValue } from "./cli-args.js";

export const EVAL_DEFAULT_LIMIT = 5;
/** `RecallInput` rejects a limit above 50, so a bigger one would die as a Zod error, not as usage. */
const EVAL_MAX_LIMIT = 50;
const EVAL_MODES = ["lexico", "semantico", "auto"] as const;
export type EvalMode = (typeof EVAL_MODES)[number];

export interface EvalArgs {
  dir?: string;
  limit: number;
  mode: EvalMode;
  json: boolean;
  help: boolean;
}

export interface ModeChoice {
  mode: "lexico" | "semantico";
  embedded: number;
  failed: number;
}

/**
 * The `modo:` line. A lexical run with embedding counters is a degraded `auto`, not a plain
 * lexical run: saying so is what makes a silent embedder failure visible.
 */
export function modeLine(chosen: ModeChoice): string {
  if (chosen.mode === "semantico") {
    const failed = chosen.failed > 0 ? `, ${chosen.failed} fallidas` : "";
    return `modo: semántico (${chosen.embedded} memorias embebidas${failed})`;
  }
  if (chosen.embedded === 0 && chosen.failed === 0) return "modo: léxico (sin embeddings)";
  const parts = [
    chosen.embedded > 0 ? `${chosen.embedded} memorias embebidas` : null,
    chosen.failed > 0 ? `${chosen.failed} fallidas` : null,
  ].filter((part): part is string => part !== null);
  return `modo: léxico (embeddings incompletos: ${parts.join(", ")})`;
}

/** The `--json` payload: the embedder counters travel with the figures that they explain. */
export function jsonPayload<T extends object>(chosen: ModeChoice, report: T): Record<string, unknown> {
  return {
    mode: chosen.mode,
    ...(chosen.embedded > 0 ? { embedded: chosen.embedded } : {}),
    ...(chosen.failed > 0 ? { failed: chosen.failed } : {}),
    ...report,
  };
}

function parseMode(raw: string): EvalMode {
  if (raw === "lexico" || raw === "semantico" || raw === "auto") return raw;
  throw new ArgsError(`--mode no es válido: ${raw} (lexico, semantico, auto)`);
}

export function parseEvalArgs(argv: readonly string[]): EvalArgs {
  const out: EvalArgs = { limit: EVAL_DEFAULT_LIMIT, mode: "auto", json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--json") out.json = true;
    else if (a === "--dir") out.dir = flagValue(argv, i++, a);
    else if (a === "--mode") out.mode = parseMode(flagValue(argv, i++, a));
    else if (a === "--limit")
      out.limit = flagNumber(argv, i++, a, { integer: true, min: 1, max: EVAL_MAX_LIMIT });
    else throw new ArgsError(`argumento desconocido: ${a}`);
  }
  return out;
}
