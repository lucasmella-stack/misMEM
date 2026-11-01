// Arguments for mismem-bench, kept apart from the CLI because the CLI runs on import.
// Strict: a mistyped flag must fail instead of silently changing what the bench prints.
import { ArgsError, flagNumber, flagValue } from "./cli-args.js";

export const BENCH_DEFAULT_LIMIT = 5;

export interface BenchArgs {
  db?: string;
  bank?: string;
  offTopic?: string;
  groups: string[];
  limit: number;
  json: boolean;
  help: boolean;
}

export function parseBenchArgs(argv: readonly string[]): BenchArgs {
  const out: BenchArgs = { groups: [], limit: BENCH_DEFAULT_LIMIT, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--json") out.json = true;
    else if (a === "--db") out.db = flagValue(argv, i++, a);
    else if (a === "--bank") out.bank = flagValue(argv, i++, a);
    else if (a === "--off-topic") out.offTopic = flagValue(argv, i++, a);
    else if (a === "--group") out.groups = flagValue(argv, i++, a).split(",").filter(Boolean);
    else if (a === "--limit") out.limit = flagNumber(argv, i++, a, { integer: true, min: 1 });
    else throw new ArgsError(`argumento desconocido: ${a}`);
  }
  return out;
}
