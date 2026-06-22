import { describe, expect, it } from 'vitest';
import { createInMemorySignupTokenStore } from '../../src/adapters/signup-token-store.js';
import type { SignupTokenRecord } from '../../src/core/index.js';

const rec = (over: Partial<SignupTokenRecord>): SignupTokenRecord => ({
  tokenHash: 'h1',
  slug: 'acme',
  expiresAt: '2026-07-01T00:00:00.000Z',
  createdAt: '2026-06-01T00:00:00.000Z',
  ...over,
});

describe('createInMemorySignupTokenStore', () => {
  it('creates, finds by hash, and returns null for unknown', async () => {
    const store = createInMemorySignupTokenStore();
    await store.create(rec({ tokenHash: 'h1' }));
    expect((await store.findByHash('h1'))?.slug).toBe('acme');
    expect(await store.findByHash('nope')).toBeNull();
  });

  it('marks a token redeemed (single-use)', async () => {
    const store = createInMemorySignupTokenStore();
    await store.create(rec({ tokenHash: 'h1' }));
    await store.markRedeemed('h1', 'tenant-1', '2026-06-10T00:00:00.000Z');
    const found = await store.findByHash('h1');
    expect(found?.redeemedAt).toBe('2026-06-10T00:00:00.000Z');
    expect(found?.redeemedTenantId).toBe('tenant-1');
  });

  it('lists newest-first, capped, and clears', async () => {
    const store = createInMemorySignupTokenStore();
    await store.create(rec({ tokenHash: 'a', createdAt: '2026-06-01T00:00:00.000Z' }));
    await store.create(rec({ tokenHash: 'b', createdAt: '2026-06-03T00:00:00.000Z' }));
    await store.create(rec({ tokenHash: 'c', createdAt: '2026-06-02T00:00:00.000Z' }));
    const rows = await store.list(2);
    expect(rows.map((r) => r.tokenHash)).toEqual(['b', 'c']);
    store.clear();
    expect(await store.list(10)).toEqual([]);
  });
});
