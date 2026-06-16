import { gateway } from '@ai-sdk/gateway';
import { embedMany } from 'ai';
import type { Vector } from '../../core/domain.js';
import type { EmbeddingProvider } from '../../ports/embedding-provider.js';

/** Configuration for the Vercel AI Gateway embedding adapter. */
export interface AiGatewayOptions {
  /** Provider/model string, e.g. `openai/text-embedding-3-small`. */
  model: string;
  /** Expected embedding dimension; returned vectors are validated against it. */
  dim: number;
  /** Maximum inputs per `embed` call (cost-DoS guardrail). Defaults to 96. */
  maxBatchSize?: number;
  /** Max retries for transient provider failures. Defaults to 2. */
  maxRetries?: number;
}

/**
 * Create an {@link EmbeddingProvider} backed by the Vercel AI Gateway.
 *
 * Auth comes from `AI_GATEWAY_API_KEY` in the environment (read by the gateway provider). The
 * provider's response is treated as untrusted: vector count and dimensions are validated before
 * being returned (CWE-20 / OWASP-LLM unsafe output handling).
 *
 * @param options - Model, dimension, and guardrails.
 * @returns An embedding provider that embeds batches via the gateway.
 */
export function createAiGatewayEmbeddingProvider(options: AiGatewayOptions): EmbeddingProvider {
  const maxBatchSize = options.maxBatchSize ?? 96;
  const maxRetries = options.maxRetries ?? 2;
  const embeddingModel = gateway.textEmbeddingModel(options.model);

  return {
    model: options.model,
    dim: options.dim,
    async embed(texts: string[]): Promise<Vector[]> {
      if (texts.length === 0) return [];
      if (texts.length > maxBatchSize) {
        throw new RangeError(
          `embedding batch of ${texts.length} exceeds maxBatchSize ${maxBatchSize}`,
        );
      }

      const { embeddings } = await embedMany({
        model: embeddingModel,
        values: texts,
        maxRetries,
      });

      if (embeddings.length !== texts.length) {
        throw new Error(
          `embedding provider returned ${embeddings.length} vectors for ${texts.length} inputs`,
        );
      }
      for (const vector of embeddings) {
        if (vector.length !== options.dim) {
          throw new Error(
            `embedding provider returned a vector of dim ${vector.length}, expected ${options.dim}`,
          );
        }
      }
      return embeddings;
    },
  };
}
