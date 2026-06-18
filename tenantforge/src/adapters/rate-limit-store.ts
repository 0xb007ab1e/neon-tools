import type { RateLimitHit, RateLimitStore } from '../ports/rate-limit-store.js';

/**
 * Create an in-memory {@link RateLimitStore} (fixed window, aligned to `windowMs`).
 *
 * The default — correct for a single instance. A multi-instance deployment wants a shared store
 * (see the Postgres-backed adapter) so the per-principal limit is global rather than per-replica.
 *
 * @returns An in-memory rate-limit store.
 */
export function createInMemoryRateLimitStore(): RateLimitStore {
  const windows = new Map<string, { count: number; startMs: number }>();
  return {
    increment(key: string, windowMs: number, nowMs: number): Promise<RateLimitHit> {
      const startMs = Math.floor(nowMs / windowMs) * windowMs;
      const prev = windows.get(key);
      const win = prev !== undefined && prev.startMs === startMs ? prev : { count: 0, startMs };
      win.count += 1;
      windows.set(key, win);
      return Promise.resolve({ count: win.count, windowStartMs: startMs });
    },
  };
}
