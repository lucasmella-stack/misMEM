// Arguments for mismem-embed, kept apart from the CLI because the CLI runs on import.
// Strict: a mistyped `--scope` must reindex nothing instead of every scope.
import { ArgsError, flagNumber, flagValue } from "./cli-args.js";

export interface EmbedArgs {
  scope?: string;
  batch: number;
  status: boolean;
  force: boolean;
  help: boolean;
}

export function parseEmbedArgs(argv: readonly string[]): EmbedArgs {
  const out: EmbedArgs = { batch: 32, status: false, force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--scope") out.scope = flagValue(argv, i++, a);
    else if (a === "--batch") out.batch = flagNumber(argv, i++, a, { integer: true, min: 1 });
    else if (a === "--stats" || a === "--status") out.status = true;
    else if (a === "--force") out.force = true;
    else throw new ArgsError(`argumento desconocido: ${a}`);
  }
  return out;
}
