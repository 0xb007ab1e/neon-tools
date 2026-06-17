/** Embedding coverage for a model: how many of the corpus's chunks it has vectors for. */
export interface ModelCoverage {
  /** Total chunks in scope. */
  total: number;
  /** Chunks that have an embedding under this model. */
  embedded: number;
}

/**
 * Whether a model has a vector for every chunk (and the corpus is non-empty).
 *
 * @param coverage - The model's coverage.
 * @returns True if fully embedded.
 */
export function isFullyEmbedded(coverage: ModelCoverage): boolean {
  return coverage.total > 0 && coverage.embedded >= coverage.total;
}

/**
 * Guard the zero-downtime invariant: never activate a model that isn't fully embedded, or queries
 * would silently degrade (missing or partial results). Throws with an explanatory message otherwise.
 *
 * @param modelName - The model being activated (for the error message).
 * @param coverage - The model's coverage.
 * @throws Error if the corpus is empty or the model is only partially embedded.
 */
export function assertActivatable(modelName: string, coverage: ModelCoverage): void {
  if (coverage.total === 0) {
    throw new Error(`cannot activate "${modelName}": no chunks have been ingested`);
  }
  if (!isFullyEmbedded(coverage)) {
    throw new Error(
      `cannot activate "${modelName}": only ${coverage.embedded}/${coverage.total} chunks are embedded — re-embed first`,
    );
  }
}
