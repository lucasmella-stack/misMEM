// How much of a measured co-occurrence was repetition. NPMI alone cannot tell evidence from
// coincidence: a pair seen once, in the only turn either memory appeared, scores the maximum
// for any sample size. The viewer keeps its own copy; `support.test.ts` ties the two together.

/**
 * In [0, 1): the share of a pair's sightings that repeated an earlier one. One sighting
 * repeats nothing, so it is worth nothing, and certainty is never reached.
 */
export function supportConfidence(n: number | undefined): number {
  if (n === undefined || n <= 1) return 0;
  return (n - 1) / n;
}
