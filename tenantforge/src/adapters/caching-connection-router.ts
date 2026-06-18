import type { ConnectionRouter, TenantConnection } from '../ports/connection-router.js';

/** Collaborators for {@link createCachingConnectionRouter}. */
export interface CachingConnectionRouterDeps {
  /** The underlying router whose resolutions are cached (e.g. `createConnectionRouter`). */
  inner: ConnectionRouter;
  /** Time-to-live for a cached resolution, in milliseconds. */
  ttlMs: number;
  /** Optional cap on cached entries; the least-recently-used is evicted past it. */
  maxEntries?: number;
  /** Injectable millisecond clock (testing). Defaults to `() => Date.now()`. */
  now?: () => number;
}

/** A {@link ConnectionRouter} that caches resolutions, with explicit invalidation hooks. */
export interface CachingConnectionRouter extends ConnectionRouter {
  /** Drop a tenant's cached resolution (call on any lifecycle/secret change). */
  invalidate(tenantId: string): void;
  /** Drop all cached resolutions. */
  clear(): void;
}

interface CacheEntry {
  value: TenantConnection;
  expiresAt: number;
}

/**
 * Wrap a {@link ConnectionRouter} with a **process-local, tenant-keyed, TTL-bounded LRU cache** so a
 * hot tenant's resolution (registry read + secret fetch) is not repeated on every request — the
 * control-plane cost of routing at fleet scale (topic-caching, topic-performance).
 *
 * - **Tenant-keyed + process-local:** never a shared cache; the cached value holds the connection URI
 *   (a secret) only in this process's memory and is never logged (topic-multi-tenancy, master §5).
 * - **Freshness:** entries expire after `ttlMs` (the staleness backstop); callers must additionally
 *   {@link CachingConnectionRouter.invalidate} on suspend/offboard/purge/erase and on secret
 *   rotation so a non-routable or re-keyed tenant is never served from cache.
 * - **Fail closed:** a failed inner resolution (non-routable / missing secret) is **never cached** —
 *   the error propagates and any stale entry for that id is dropped.
 * - **Single-flight:** concurrent misses for the same id share one inner call (no thundering herd).
 * - **Bounded:** past `maxEntries`, the least-recently-used entry is evicted.
 *
 * This caches *resolution*; managing live database connection **pools** is the data-plane consumer's
 * responsibility (TenantForge hands out a URI, not a pool).
 *
 * @param deps - The inner router, TTL, and optional max-entries / clock.
 * @returns A caching connection router.
 */
export function createCachingConnectionRouter(
  deps: CachingConnectionRouterDeps,
): CachingConnectionRouter {
  const { inner, ttlMs } = deps;
  const now = deps.now ?? ((): number => Date.now());
  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<TenantConnection>>();

  return {
    async resolve(tenantId: string): Promise<TenantConnection> {
      const fresh = cache.get(tenantId);
      if (fresh !== undefined && fresh.expiresAt > now()) {
        // LRU bump: re-insert so Map iteration order reflects recency.
        cache.delete(tenantId);
        cache.set(tenantId, fresh);
        return fresh.value;
      }
      // Stale/absent → drop any expired entry and coalesce concurrent misses (single-flight).
      cache.delete(tenantId);
      const pending = inflight.get(tenantId);
      if (pending !== undefined) return pending;

      const load = (async (): Promise<TenantConnection> => {
        try {
          const value = await inner.resolve(tenantId);
          cache.set(tenantId, { value, expiresAt: now() + ttlMs });
          if (deps.maxEntries !== undefined && cache.size > deps.maxEntries) {
            const oldest = cache.keys().next().value; // least-recently-used (front of insertion order)
            if (oldest !== undefined) cache.delete(oldest);
          }
          return value;
        } finally {
          inflight.delete(tenantId);
        }
      })();
      inflight.set(tenantId, load);
      return load;
    },

    invalidate(tenantId: string): void {
      cache.delete(tenantId);
    },

    clear(): void {
      cache.clear();
    },
  };
}
