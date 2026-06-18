import { describe, expect, it } from 'vitest';
import { createInMemoryRateLimitStore } from '../../src/adapters/rate-limit-store.js';

describe('createInMemoryRateLimitStore', () => {
  it('counts hits within the same aligned window', async () => {
    const s = createInMemoryRateLimitStore();
    expect(await s.increment('k', 1000, 0)).toEqual({ count: 1, windowStartMs: 0 });
    expect(await s.increment('k', 1000, 400)).toEqual({ count: 2, windowStartMs: 0 });
    expect(await s.increment('k', 1000, 999)).toEqual({ count: 3, windowStartMs: 0 });
  });

  it('resets when the window rolls over (aligned to windowMs)', async () => {
    const s = createInMemoryRateLimitStore();
    await s.increment('k', 1000, 500); // window 0
    const next = await s.increment('k', 1000, 1000); // window 1000
    expect(next).toEqual({ count: 1, windowStartMs: 1000 });
  });

  it('isolates counts per key', async () => {
    const s = createInMemoryRateLimitStore();
    await s.increment('a', 1000, 0);
    await s.increment('a', 1000, 0);
    expect(await s.increment('b', 1000, 0)).toEqual({ count: 1, windowStartMs: 0 });
    expect(await s.increment('a', 1000, 0)).toEqual({ count: 3, windowStartMs: 0 });
  });
});
