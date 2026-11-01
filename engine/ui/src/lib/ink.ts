// Owns the salience-to-ink mapping, from `ink-muted` at 0 % (AA in both themes) to `ink` at
// 100 %; the CSS mixes it with color-mix, so this only normalises and clamps.
export function inkPercent(salience: number): number {
  if (!Number.isFinite(salience)) return 100;
  return Math.round(Math.max(0, Math.min(1, salience)) * 100);
}
