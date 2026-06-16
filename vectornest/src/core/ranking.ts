/**
 * Convert a pgvector cosine distance (`<=>`) into a similarity score in [0, 1].
 *
 * pgvector cosine distance is `1 - cosine_similarity`; this returns the cosine similarity clamped
 * to [0, 1] so callers get a stable, higher-is-better score.
 *
 * @param distance - The cosine distance from pgvector.
 * @returns A similarity score in [0, 1].
 */
export function cosineDistanceToScore(distance: number): number {
  const similarity = 1 - distance;
  if (similarity < 0) return 0;
  if (similarity > 1) return 1;
  return similarity;
}

/**
 * Sort scored items by descending score and take the top `k`.
 *
 * Stable, pure ranking used to finalize query results. (Hybrid vector+FTS merging plugs in here in
 * the Month-1 milestone.)
 *
 * @param items - Items carrying a numeric `score`.
 * @param k - Maximum number of items to return.
 * @returns A new array of the top-`k` items, highest score first.
 * @throws RangeError if `k` is negative.
 */
export function rankByScore<T extends { score: number }>(items: readonly T[], k: number): T[] {
  if (!Number.isInteger(k) || k < 0) {
    throw new RangeError('k must be a non-negative integer');
  }
  return [...items].sort((a, b) => b.score - a.score).slice(0, k);
}
