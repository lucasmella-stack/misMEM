/**
 * Arguments for mismem-eval, kept apart from the CLI because the CLI runs on import.
 */
import { ArgsError, flagNumber, flagValue } from "./cli-args.js";

export const EVAL_DEFAULT_LIMIT = 5;
const EVAL_MODES = ["lexico", "semantico", "auto"] as const;
export type EvalMode = (typeof EVAL_MODES)[number];

export interface EvalArgs {
  dir?: string;
  limit: number;
  mode: EvalMode;
  json: boolean;
  help: boolean;
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
    else if (a === "--limit") out.limit = flagNumber(argv, i++, a, { integer: true, min: 1 });
    else throw new ArgsError(`argumento desconocido: ${a}`);
  }
  return out;
}
