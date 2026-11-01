// Arguments for mismem-migrate-engram, kept apart from the CLI because the CLI runs on import.
// Strict: a mistyped `--dryrun` must count nothing instead of migrating for real.
import { ArgsError, flagValue } from "./cli-args.js";

export interface MigrateEngramArgs {
  source: string;
  dryRun: boolean;
  scopePrefix: string;
  help: boolean;
}

export function parseMigrateEngramArgs(argv: readonly string[]): MigrateEngramArgs {
  const out: MigrateEngramArgs = { source: "", dryRun: false, scopePrefix: "engram", help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--source") out.source = flagValue(argv, i++, a);
    else if (a === "--scope-prefix") out.scopePrefix = flagValue(argv, i++, a);
    else throw new ArgsError(`argumento desconocido: ${a}`);
  }
  return out;
}
