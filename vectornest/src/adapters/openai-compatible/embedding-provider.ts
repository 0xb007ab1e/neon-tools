import { z } from 'zod';
import type { Vector } from '../../core/domain.js';
import type { EmbeddingProvider } from '../../ports/embedding-provider.js';

/** Shape of an OpenAI-compatible `/embeddings` response (the bits we rely on). */
const EmbeddingResponseSchema = z.object({
  data: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        embedding: z.array(z.number()),
      }),
    )
    .min(1),
});

/** Configuration for the OpenAI-compatible embedding adapter. */
export interface OpenAiCompatibleOptions {
  /** Base URL including the `/v1` segment, e.g. a Cloudflare Workers AI or Ollama endpoint. */
  baseUrl: string;
  /** Model identifier, e.g. `@cf/baai/bge-base-en-v1.5`. */
  model: string;
  /** Expected embedding dimension; returned vectors are validated against it. */
  dim: number;
  /** Bearer token. Omit for keyless local servers (e.g. Ollama). */
  apiKey?: string;
  /** Maximum inputs per request (cost-DoS guardrail). Defaults to 96. */
  maxBatchSize?: number;
  /** Retries for transient failures (429/5xx/network). Defaults to 2. */
  maxRetries?: number;
  /** Per-request timeout in ms. Defaults to 30000. */
  timeoutMs?: number;
  /** Base backoff in ms (doubled per attempt). Defaults to 250. */
  retryBaseMs?: number;
  /** Injectable fetch (for testing). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/** Resolve after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read a response body as text without throwing. */
async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/**
 * Create an {@link EmbeddingProvider} for any OpenAI-compatible `/embeddings` endpoint
 * (Cloudflare Workers AI, Ollama, Gemini's compat endpoint, etc.).
 *
 * The endpoint is an untrusted upstream: the response is schema-validated and vector
 * count + dimensions are checked before use (CWE-20, OWASP-LLM unsafe output). Requests
 * carry a timeout and bounded retry/backoff on transient failures.
 *
 * @param options - Endpoint, model, dimension, and guardrails.
 * @returns An embedding provider.
 */
export function createOpenAiCompatibleEmbeddingProvider(
  options: OpenAiCompatibleOptions,
): EmbeddingProvider {
  const maxBatchSize = options.maxBatchSize ?? 96;
  const maxRetries = options.maxRetries ?? 2;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const retryBaseMs = options.retryBaseMs ?? 250;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const endpoint = `${options.baseUrl.replace(/\/+$/, '')}/embeddings`;

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.apiKey !== undefined && options.apiKey !== '') {
    headers.authorization = `Bearer ${options.apiKey}`;
  }

  const requestEmbeddings = async (texts: string[]): Promise<unknown> => {
    const body = JSON.stringify({ model: options.model, input: texts });
    let lastError: Error = new Error('embeddings request failed');
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });
      } catch (error) {
        // Network/abort failure: retry unless this was the final attempt.
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt === maxRetries) throw lastError;
        await delay(retryBaseMs * 2 ** attempt);
        continue;
      } finally {
        clearTimeout(timer);
      }

      if (response.ok) return await response.json();

      const detail = await safeText(response);
      lastError = new Error(`embeddings request failed: HTTP ${response.status} ${detail}`);
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === maxRetries) throw lastError;
      await delay(retryBaseMs * 2 ** attempt);
    }
    /* c8 ignore next -- defensive: the final attempt always returns or throws above */
    throw lastError;
  };

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

      const json = await requestEmbeddings(texts);
      const parsed = EmbeddingResponseSchema.parse(json);
      if (parsed.data.length !== texts.length) {
        throw new Error(
          `embedding provider returned ${parsed.data.length} vectors for ${texts.length} inputs`,
        );
      }

      return [...parsed.data]
        .sort((a, b) => a.index - b.index)
        .map((item) => {
          if (item.embedding.length !== options.dim) {
            throw new Error(
              `embedding provider returned a vector of dim ${item.embedding.length}, expected ${options.dim}`,
            );
          }
          return item.embedding;
        });
    },
  };
}
