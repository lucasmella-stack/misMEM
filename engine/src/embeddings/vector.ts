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
 * Copies of `vectors` scaled to unit L2 norm, or null when the batch cannot be trusted.
 *
 * One NaN component makes every cosine NaN, and `NaN >= minScore` is false: that memory
 * vanishes from semantic search for good while the backfill already counts it as embedded.
 * The batch is validated as a whole because a half-written batch leaves the rest without a
 * vector for this run, so callers treat null exactly like an unreachable server.
 */
export function checkedUnitVectors(vectors: ArrayLike<number>[]): Float32Array[] | null {
  const first = vectors[0];
  if (!first || first.length === 0) return null;
  const dims = first.length;
  const unit: Float32Array[] = [];
  for (const vector of vectors) {
    if (vector.length !== dims) return null;
    const copy = new Float32Array(dims);
    let squares = 0;
    for (let i = 0; i < dims; i++) {
      const value = vector[i];
      if (value === undefined) return null;
      copy[i] = value;
      // The sum is taken from the stored copy: 1e39 is finite as a double and becomes
      // Infinity here, and any non-finite component leaves `squares` non-finite as well.
      const stored = copy[i] ?? 0;
      squares += stored * stored;
    }
    const norm = Math.sqrt(squares);
    if (!Number.isFinite(norm) || norm === 0) return null;
    for (let i = 0; i < dims; i++) copy[i] = (copy[i] ?? 0) / norm;
    unit.push(copy);
  }
  return unit;
}
