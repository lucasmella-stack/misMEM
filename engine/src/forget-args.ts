// Arguments for mismem-forget, kept apart from the CLI because the CLI runs on import.
// Strict on purpose: the CLI deletes by default, so an unknown flag (a mistyped `--dryrun`)
// cannot be ignored while the real purge runs.
import { ArgsError, flagNumber, flagValue } from "./cli-args.js";
import { Scope } from "./schema.js";

export interface ForgetArgs {
  scope?: string;
  beforeDays: number;
  memoryGraceDays: number;
  salienceBelow: number;
  dryRun: boolean;
  help: boolean;
}

export function parseForgetArgs(argv: readonly string[]): ForgetArgs {
  const out: ForgetArgs = {
    beforeDays: 90,
    memoryGraceDays: 30,
    salienceBelow: 0.1,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--scope") {
      // Same limit as the forget schema: otherwise Zod rejects it after opening the database, with exit 1.
      out.scope = flagValue(argv, i++, a);
      if (!Scope.safeParse(out.scope).success) throw new ArgsError(`--scope admite hasta 128 caracteres`);
    }
    else if (a === "--before-days") out.beforeDays = flagNumber(argv, i++, a, { integer: true, min: 1 });
    else if (a === "--memory-grace-days") out.memoryGraceDays = flagNumber(argv, i++, a, { integer: true, min: 0 });
    // Same range as the `forget` schema (0..1): outside it, Zod fails with exit 1 after opening the database.
    else if (a === "--salience-below") out.salienceBelow = flagNumber(argv, i++, a, { min: 0, max: 1 });
    else throw new ArgsError(`argumento desconocido: ${a}`);
  }
  return out;
}
