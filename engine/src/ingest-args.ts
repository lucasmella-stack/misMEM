// Arguments for mismem-ingest, kept apart from the CLI because the CLI runs on import.
// Strict: a mistyped subcommand must be named in the error, not answered with bare help.
import { ArgsError } from "./cli-args.js";

export type IngestArgs =
  | { command: "help" }
  | { command: "walk"; root: string; scopePrefix: string }
  | { command: "file"; path: string; scope: string }
  | { command: "chatgpt"; root: string }
  | { command: "vscode"; userDir: string }
  | { command: "stats" };

const ARITY: Record<IngestArgs["command"], number> = {
  help: 0,
  walk: 2,
  file: 2,
  chatgpt: 1,
  vscode: 1,
  stats: 0,
};

export function parseIngestArgs(argv: readonly string[]): IngestArgs {
  const [command, ...args] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    return { command: "help" };
  }
  if (!Object.hasOwn(ARITY, command)) throw new ArgsError(`subcomando desconocido: ${command}`);

  const expected = ARITY[command as IngestArgs["command"]];
  if (args.length < expected) {
    const plural = expected === 1 ? "argumento" : "argumentos";
    throw new ArgsError(`${command} necesita ${expected} ${plural}`);
  }
  if (args.length > expected) throw new ArgsError(`argumento desconocido: ${args[expected]}`);

  args.forEach((arg, i) => {
    // As in flagValue, a blank positional is a missing value, and `resolve("")` is the cwd.
    if (arg.trim() === "") throw new ArgsError(`${command}: el argumento ${i + 1} está vacío`);
  });

  switch (command) {
    case "walk":
      return { command, root: args[0]!, scopePrefix: args[1]! };
    case "file":
      return { command, path: args[0]!, scope: args[1]! };
    case "chatgpt":
      return { command, root: args[0]! };
    case "vscode":
      return { command, userDir: args[0]! };
    case "stats":
      return { command: "stats" };
    default:
      throw new ArgsError(`subcomando desconocido: ${command}`);
  }
}
