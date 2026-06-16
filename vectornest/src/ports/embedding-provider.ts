import type { Vector } from '../core/domain.js';

/**
 * Port: turns text into embedding vectors via some provider (e.g. an OpenAI-compatible endpoint).
 *
 * Implementations are injected at the composition root. Callers treat the returned vectors as
 * untrusted until validated: an adapter MUST return exactly one vector per input, each of length
 * {@link EmbeddingProvider.dim}.
 */
export interface EmbeddingProvider {
  /** Provider/model string this instance embeds with, e.g. `openai/text-embedding-3-small`. */
  readonly model: string;

  /** Dimension of every vector this provider returns. */
  readonly dim: number;

  /**
   * Embed a batch of texts.
   *
   * @param texts - Input strings to embed.
   * @returns One vector per input, in the same order; each of length {@link EmbeddingProvider.dim}.
   */
  embed(texts: string[]): Promise<Vector[]>;
}
