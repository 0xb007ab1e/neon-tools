import type {
  IdempotencyBegin,
  IdempotencyStore,
  IdempotentResponse,
} from '../ports/idempotency-store.js';

/** Default retention for an idempotency key: 24 hours. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

interface Record {
  fingerprint: string;
  createdMs: number;
  response: IdempotentResponse | null;
}

/**
 * Create an in-memory {@link IdempotencyStore}.
 *
 * The default — correct for a single instance. A multi-instance deployment wants a shared store
 * (see the Postgres-backed adapter) so a retry that lands on a different replica still
 * de-duplicates. Records expire after `ttlMs`; a memory-bound deployment should prefer the shared
 * store, since this map only evicts expired keys lazily on access.
 *
 * @param options - Optional retention (`ttlMs`, default 24h).
 * @returns An in-memory idempotency store.
 */
export function createInMemoryIdempotencyStore(options?: { ttlMs?: number }): IdempotencyStore {
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const records = new Map<string, Record>();
  return {
    // Single-threaded: this check-then-set runs without an intervening await, so it is atomic.
    begin(key: string, fingerprint: string, nowMs: number): Promise<IdempotencyBegin> {
      const existing = records.get(key);
      const expired = existing !== undefined && nowMs - existing.createdMs >= ttlMs;
      if (existing === undefined || expired) {
        records.set(key, { fingerprint, createdMs: nowMs, response: null });
        return Promise.resolve({ outcome: 'new' });
      }
      if (existing.fingerprint !== fingerprint) return Promise.resolve({ outcome: 'mismatch' });
      if (existing.response === null) return Promise.resolve({ outcome: 'in_flight' });
      return Promise.resolve({ outcome: 'replay', response: existing.response });
    },

    complete(key: string, response: IdempotentResponse, _nowMs: number): Promise<void> {
      const existing = records.get(key);
      if (existing !== undefined) existing.response = response;
      return Promise.resolve();
    },
  };
}
