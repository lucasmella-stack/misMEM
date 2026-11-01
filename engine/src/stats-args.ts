// Arguments for mismem-stats, kept apart from the CLI because the CLI runs on import.
// Strict: a mistyped `--scop` must fail instead of reporting every scope.
import { ArgsError, flagValue } from "./cli-args.js";

export interface StatsArgs {
  json: boolean;
  scope?: string;
  help: boolean;
}

export function parseStatsArgs(argv: readonly string[]): StatsArgs {
  const out: StatsArgs = { json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--json") out.json = true;
    else if (a === "--scope") out.scope = flagValue(argv, i++, a);
    else throw new ArgsError(`argumento desconocido: ${a}`);
  }
  return out;
}
