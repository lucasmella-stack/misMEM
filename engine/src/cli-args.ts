// Strict flag parsing for the CLIs that delete or spend: an unknown flag aborts with a usage
// error instead of being ignored while something else runs.

/** EX_USAGE from sysexits.h: distinct from 1 (failure) and from the 2 consolidate uses for failed scopes. */
export const EXIT_USAGE = 64;

export class ArgsError extends Error {
  override name = "ArgsError";
}

/** The value after `flag` at `argv[i + 1]`; another `--flag` does not count as a value. */
export function flagValue(argv: readonly string[], i: number, flag: string): string {
  const value = argv[i + 1];
  // A blank value is a missing value: if it slipped through, the later validator (`--scope ""`)
  // would fail with exit 1 where the CLI's contract is a usage error.
  if (value === undefined || value.trim() === "" || value.startsWith("--")) {
    throw new ArgsError(`${flag} necesita un valor`);
  }
  return value;
}

export function flagNumber(
  argv: readonly string[],
  i: number,
  flag: string,
  opts: { integer?: boolean; min?: number; max?: number } = {},
): number {
  const raw = flagValue(argv, i, flag);
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value)) throw new ArgsError(`${flag} no es un número: ${raw}`);
  if (opts.integer && !Number.isInteger(value)) throw new ArgsError(`${flag} tiene que ser entero: ${raw}`);
  if (opts.min !== undefined && value < opts.min) throw new ArgsError(`${flag} tiene que ser >= ${opts.min}: ${raw}`);
  if (opts.max !== undefined && value > opts.max) throw new ArgsError(`${flag} tiene que ser <= ${opts.max}: ${raw}`);
  return value;
}
