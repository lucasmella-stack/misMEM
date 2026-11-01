const relative = new Intl.RelativeTimeFormat("es", { numeric: "auto" });
const absolute = new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short" });

const STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 86_400_000],
  ["month", 30 * 86_400_000],
  ["week", 7 * 86_400_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** "hace 3 días": what matters about a memory is how long ago, not the exact date. */
export function ago(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return "nunca";
  const diff = ts - now;
  for (const [unit, ms] of STEPS) {
    if (Math.abs(diff) >= ms) return relative.format(Math.round(diff / ms), unit);
  }
  return "ahora";
}

export const exact = (ts: number): string => absolute.format(new Date(ts));

/** The relative one to orient yourself, the absolute one to avoid doing the math. */
export function when(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return "nunca";
  return `${ago(ts, now)} (${exact(ts)})`;
}

export const percent = (value: number): string => `${Math.round(value * 100)} %`;
