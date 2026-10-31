// Numeric env vars, parsed one way everywhere: finite and above zero; anything else (unset,
// empty, "abc", 0, negative) counts as not set, because a zero window, timeout or batch size
// is never a useful setting.
export function envPositiveNumber(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return envOptionalPositiveNumber(name, env) ?? fallback;
}

/** Zero is a valid setting here (e.g. "no minimum age"); unset, empty, garbage and negatives fall back. */
export function envNonNegativeNumber(name: string, fallback: number): number {
  // An empty string would parse as 0, which here is a real value, so it is rejected first.
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Same rule, for callers whose own default lives further down and must see "not set". */
export function envOptionalPositiveNumber(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
