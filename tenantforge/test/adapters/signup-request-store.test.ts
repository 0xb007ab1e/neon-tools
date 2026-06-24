import { describe, expect, it } from 'vitest';
import { createInMemorySignupRequestStore } from '../../src/adapters/signup-request-store.js';
import type { SignupRequestRecord } from '../../src/core/index.js';

const rec = (over: Partial<SignupRequestRecord>): SignupRequestRecord => ({
  id: 's1',
  email: 'new@example.com',
  status: 'started',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  ...over,
});

describe('createInMemorySignupRequestStore', () => {
  it('creates, gets by id, and returns null for unknown', async () => {
    const store = createInMemorySignupRequestStore();
    await store.create(rec({ id: 's1' }));
    expect((await store.get('s1'))?.email).toBe('new@example.com');
    expect(await store.get('nope')).toBeNull();
  });

  it('advances the funnel via patches (no-op for unknown id)', async () => {
    const store = createInMemorySignupRequestStore();
    await store.create(rec({ id: 's1' }));
    await store.update('s1', { status: 'email_verified', updatedAt: '2026-06-01T00:01:00.000Z' });
    await store.update('s1', {
      status: 'payment_ready',
      customerRef: 'cus_1',
      setupIntentId: 'seti_1',
    });
    const r = await store.get('s1');
    expect(r?.status).toBe('payment_ready');
    expect(r?.customerRef).toBe('cus_1');
    expect(r?.setupIntentId).toBe('seti_1');
    await store.update('unknown', { status: 'active' }); // no throw
  });

  it('lists newest-first, capped, and clears', async () => {
    const store = createInMemorySignupRequestStore();
    await store.create(rec({ id: 'a', createdAt: '2026-06-01T00:00:00.000Z' }));
    await store.create(rec({ id: 'b', createdAt: '2026-06-03T00:00:00.000Z' }));
    await store.create(rec({ id: 'c', createdAt: '2026-06-02T00:00:00.000Z' }));
    expect((await store.list(2)).map((r) => r.id)).toEqual(['b', 'c']);
    store.clear();
    expect(await store.list(10)).toEqual([]);
  });
});
