import { describe, expect, it, vi } from 'vitest';
import { createOpenAiCompatibleEmbeddingProvider } from '../../src/adapters/openai-compatible/embedding-provider.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const okBody = (vectors: number[][]) => ({
  data: vectors.map((embedding, index) => ({ index, embedding })),
});

const asFetch = (fn: unknown): typeof fetch => fn as typeof fetch;

describe('createOpenAiCompatibleEmbeddingProvider', () => {
  it('returns [] for empty input without calling fetch', async () => {
    const fetchImpl = vi.fn();
    const provider = createOpenAiCompatibleEmbeddingProvider({
      baseUrl: 'http://x/v1',
      model: 'm',
      dim: 2,
      fetchImpl: asFetch(fetchImpl),
    });
    expect(await provider.embed([])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('embeds, preserves order by index, and normalizes the endpoint', async () => {
    const fetchImpl = vi.fn(async (_url: string) =>
      jsonResponse({
        data: [
          { index: 1, embedding: [3, 4] },
          { index: 0, embedding: [1, 2] },
        ],
      }),
    );
    const provider = createOpenAiCompatibleEmbeddingProvider({
      baseUrl: 'http://x/v1/',
      model: 'm',
      dim: 2,
      fetchImpl: asFetch(fetchImpl),
    });
    expect(await provider.embed(['a', 'b'])).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://x/v1/embeddings');
  });

  it('sends a bearer header only when an apiKey is set', async () => {
    const inits: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      inits.push(init);
      return jsonResponse(okBody([[1, 1]]));
    });
    await createOpenAiCompatibleEmbeddingProvider({
      baseUrl: 'http://x/v1',
      model: 'm',
      dim: 2,
      apiKey: 'secret',
      fetchImpl: asFetch(fetchImpl),
    }).embed(['a']);
    await createOpenAiCompatibleEmbeddingProvider({
      baseUrl: 'http://x/v1',
      model: 'm',
      dim: 2,
      fetchImpl: asFetch(fetchImpl),
    }).embed(['a']);
    expect((inits[0]?.headers as Record<string, string>).authorization).toBe('Bearer secret');
    expect((inits[1]?.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('throws when the batch exceeds maxBatchSize', async () => {
    const provider = createOpenAiCompatibleEmbeddingProvider({
      baseUrl: 'http://x/v1',
      model: 'm',
      dim: 2,
      maxBatchSize: 1,
      fetchImpl: asFetch(async () => jsonResponse(okBody([[1, 1]]))),
    });
    await expect(provider.embed(['a', 'b'])).rejects.toThrow(/exceeds maxBatchSize/);
  });

  it('throws on vector count mismatch', async () => {
    const provider = createOpenAiCompatibleEmbeddingProvider({
      baseUrl: 'http://x/v1',
      model: 'm',
      dim: 2,
      fetchImpl: asFetch(async () => jsonResponse(okBody([[1, 1]]))),
    });
    await expect(provider.embed(['a', 'b'])).rejects.toThrow(/returned 1 vectors for 2/);
  });

  it('throws on dimension mismatch', async () => {
    const provider = createOpenAiCompatibleEmbeddingProvider({
      baseUrl: 'http://x/v1',
      model: 'm',
      dim: 3,
      fetchImpl: asFetch(async () => jsonResponse(okBody([[1, 1]]))),
    });
    await expect(provider.embed(['a'])).rejects.toThrow(/dim 2, expected 3/);
  });

  it('throws on a malformed response body', async () => {
    const provider = createOpenAiCompatibleEmbeddingProvider({
      baseUrl: 'http://x/v1',
      model: 'm',
      dim: 2,
      fetchImpl: asFetch(async () => jsonResponse({ wrong: true })),
    });
    await expect(provider.embed(['a'])).rejects.toBeInstanceOf(Error);
  });

  it('does not retry a 4xx and surfaces the status', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'bad' }, 400));
    const provider = createOpenAiCompatibleEmbeddingProvider({
      baseUrl: 'http://x/v1',
      model: 'm',
      dim: 2,
      maxRetries: 3,
      retryBaseMs: 0,
      fetchImpl: asFetch(fetchImpl),
    });
    await expect(provider.embed(['a'])).rejects.toThrow(/HTTP 400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a 5xx then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'down' }, 503))
      .mockResolvedValueOnce(jsonResponse(okBody([[1, 2]])));
    const provider = createOpenAiCompatibleEmbeddingProvider({
      baseUrl: 'http://x/v1',
      model: 'm',
      dim: 2,
      maxRetries: 2,
      retryBaseMs: 0,
      fetchImpl: asFetch(fetchImpl),
    });
    expect(await provider.embed(['a'])).toEqual([[1, 2]]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries network errors and gives up after maxRetries', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const provider = createOpenAiCompatibleEmbeddingProvider({
      baseUrl: 'http://x/v1',
      model: 'm',
      dim: 2,
      maxRetries: 2,
      retryBaseMs: 0,
      fetchImpl: asFetch(fetchImpl),
    });
    await expect(provider.embed(['a'])).rejects.toThrow(/ECONNRESET/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('aborts on timeout', async () => {
    const fetchImpl = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const provider = createOpenAiCompatibleEmbeddingProvider({
      baseUrl: 'http://x/v1',
      model: 'm',
      dim: 2,
      maxRetries: 0,
      retryBaseMs: 0,
      timeoutMs: 5,
      fetchImpl: asFetch(fetchImpl),
    });
    await expect(provider.embed(['a'])).rejects.toThrow(/aborted/);
  });
});
