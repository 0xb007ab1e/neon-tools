import { describe, expect, it, vi } from 'vitest';
import type { ConnectionRouter, TenantConnection } from '../../src/ports/connection-router.js';
import { createCachingConnectionRouter } from '../../src/adapters/caching-connection-router.js';

/** An inner router that counts calls and resolves `uri-<id>`, or rejects for ids in `failFor`. */
function fakeInner(failFor: Set<string> = new Set()): ConnectionRouter & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resolve(tenantId: string): Promise<TenantConnection> {
      calls.push(tenantId);
      if (failFor.has(tenantId)) return Promise.reject(new Error(`not routable: ${tenantId}`));
      return Promise.resolve({ tenantId, connectionUri: `uri-${tenantId}` });
    },
  };
}

/** A controllable millisecond clock. */
function clock(start = 1000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe('createCachingConnectionRouter', () => {
  it('caches a resolution within the TTL (inner called once)', async () => {
    const inner = fakeInner();
    const router = createCachingConnectionRouter({ inner, ttlMs: 1000, now: clock().now });
    const a = await router.resolve('t1');
    const b = await router.resolve('t1');
    expect(a).toEqual({ tenantId: 't1', connectionUri: 'uri-t1' });
    expect(b).toBe(a); // same cached object
    expect(inner.calls).toEqual(['t1']);
  });

  it('re-resolves after the TTL expires', async () => {
    const inner = fakeInner();
    const c = clock();
    const router = createCachingConnectionRouter({ inner, ttlMs: 1000, now: c.now });
    await router.resolve('t1');
    c.advance(1001);
    await router.resolve('t1');
    expect(inner.calls).toEqual(['t1', 't1']);
  });

  it('never caches a failed (non-routable) resolution and propagates the error', async () => {
    const inner = fakeInner(new Set(['t1']));
    const router = createCachingConnectionRouter({ inner, ttlMs: 1000, now: clock().now });
    await expect(router.resolve('t1')).rejects.toThrow(/not routable/);
    await expect(router.resolve('t1')).rejects.toThrow(/not routable/);
    expect(inner.calls).toEqual(['t1', 't1']); // each attempt hit the inner router
  });

  it('coalesces concurrent misses into a single inner call (single-flight)', async () => {
    let resolveInner: (v: TenantConnection) => void = () => {};
    const inner: ConnectionRouter & { calls: number } = {
      calls: 0,
      resolve(_tenantId: string) {
        this.calls += 1;
        return new Promise<TenantConnection>((res) => {
          resolveInner = res;
        });
      },
    };
    const router = createCachingConnectionRouter({ inner, ttlMs: 1000, now: clock().now });
    const p1 = router.resolve('t1');
    const p2 = router.resolve('t1');
    resolveInner({ tenantId: 't1', connectionUri: 'uri-t1' });
    const [a, b] = await Promise.all([p1, p2]);
    expect(inner.calls).toBe(1);
    expect(a).toEqual(b);
  });

  it('invalidate() drops a tenant so the next resolve re-fetches', async () => {
    const inner = fakeInner();
    const router = createCachingConnectionRouter({ inner, ttlMs: 1000, now: clock().now });
    await router.resolve('t1');
    router.invalidate('t1');
    await router.resolve('t1');
    expect(inner.calls).toEqual(['t1', 't1']);
  });

  it('clear() drops all cached resolutions', async () => {
    const inner = fakeInner();
    const router = createCachingConnectionRouter({ inner, ttlMs: 1000, now: clock().now });
    await router.resolve('t1');
    await router.resolve('t2');
    router.clear();
    await router.resolve('t1');
    expect(inner.calls).toEqual(['t1', 't2', 't1']);
  });

  it('evicts the least-recently-used entry past maxEntries (recent access survives)', async () => {
    const inner = fakeInner();
    const router = createCachingConnectionRouter({
      inner,
      ttlMs: 10_000,
      maxEntries: 2,
      now: clock().now,
    });
    await router.resolve('a'); // [a]
    await router.resolve('b'); // [a, b]
    await router.resolve('a'); // LRU bump → [b, a]  (cached, inner not called again)
    await router.resolve('c'); // size 3 > 2 → evict 'b' → [a, c]
    expect(inner.calls).toEqual(['a', 'b', 'c']); // 'a' served from cache on its 2nd call

    await router.resolve('a'); // still cached
    await router.resolve('c'); // still cached
    await router.resolve('b'); // evicted earlier → re-fetched
    expect(inner.calls).toEqual(['a', 'b', 'c', 'b']);
  });

  it('uses a real clock by default', async () => {
    const inner = fakeInner();
    const spy = vi.spyOn(Date, 'now');
    try {
      const router = createCachingConnectionRouter({ inner, ttlMs: 1000 });
      await router.resolve('t1');
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
