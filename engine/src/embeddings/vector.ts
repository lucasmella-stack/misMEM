// Owns the vector math (cosine) and the normalization of provider output, apart from the env config and the SQL that surround it.

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return -1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return -1;
  const score = dot / denom;
  // A row poisoned with NaN or Infinity before this check existed must not break the
  // ordering: -1 ranks it last instead of making the whole sort inconsistent.
  return Number.isFinite(score) ? score : -1;
}

/**
 * Copy of `vector` scaled to unit L2 norm, or null when that one vector cannot be trusted.
 *
 * One NaN component makes every cosine NaN, and `NaN >= minScore` is false: that memory
 * vanishes from semantic search for good while the backfill already counts it as embedded.
 * `Number.isFinite` catches a sparse hole, a JSON `null` and any non-numeric value before
 * it is copied, because `copy[i] = null` would silently store a zero.
 */
export function unitVector(vector: ArrayLike<number>): Float32Array | null {
  const dims = vector.length;
  if (dims === 0) return null;
  const copy = new Float32Array(dims);
  let squares = 0;
  for (let i = 0; i < dims; i++) {
    // `?? NaN` because a sparse hole arrives as undefined and null is not a number either.
    const value = vector[i] ?? Number.NaN;
    if (!Number.isFinite(value)) return null;
    copy[i] = value;
    // The sum is taken from the stored copy: 1e39 is finite as a double and becomes
    // Infinity here, and any non-finite component leaves `squares` non-finite as well.
    const stored = copy[i] ?? 0;
    squares += stored * stored;
  }
  const norm = Math.sqrt(squares);
  if (!Number.isFinite(norm) || norm === 0) return null;
  for (let i = 0; i < dims; i++) copy[i] = (copy[i] ?? 0) / norm;
  return copy;
}

/**
 * Copies of `vectors` scaled to unit L2 norm, one entry per input, with `null` for each
 * vector that cannot be trusted. Returns null only when the batch shape itself is impossible.
 *
 * A bad vector only loses itself: rejecting the whole batch would make its good neighbours
 * pending forever, because the pending order is stable across runs and they would always
 * land in the same poisoned batch. The batch is null for an empty list, a vector without
 * dimensions, or valid vectors with different dimensions; callers treat that exactly like
 * an unreachable server.
 */
export function checkedUnitVectors(
  vectors: readonly (ArrayLike<number> | null | undefined)[],
): Array<Float32Array | null> | null {
  if (vectors.length === 0) return null;
  if (vectors.some((vector) => vector !== null && vector !== undefined && vector.length === 0)) {
    return null;
  }
  const unit = vectors.map((vector) => (vector ? unitVector(vector) : null));
  const dims = new Set<number>();
  vectors.forEach((vector, i) => {
    if (vector && unit[i]) dims.add(vector.length);
  });
  return dims.size > 1 ? null : unit;
}
