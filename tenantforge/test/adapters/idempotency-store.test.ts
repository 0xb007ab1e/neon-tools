import { describe, expect, it } from 'vitest';
import { createInMemoryIdempotencyStore } from '../../src/adapters/idempotency-store.js';

const response = { status: 201, body: '{"ok":true}', contentType: 'application/json' };

describe('in-memory idempotency store', () => {
  it('reserves a new key, reports in-flight until completed, then replays', async () => {
    const store = createInMemoryIdempotencyStore();
    expect(await store.begin('k1', 'fp', 1000)).toEqual({ outcome: 'new' });
    // Reserved but not completed → a concurrent retry sees in-flight.
    expect(await store.begin('k1', 'fp', 1001)).toEqual({ outcome: 'in_flight' });
    await store.complete('k1', response, 1002);
    expect(await store.begin('k1', 'fp', 1003)).toEqual({ outcome: 'replay', response });
  });

  it('flags a key reused with a different request fingerprint', async () => {
    const store = createInMemoryIdempotencyStore();
    await store.begin('k1', 'fp-a', 1000);
    expect(await store.begin('k1', 'fp-b', 1001)).toEqual({ outcome: 'mismatch' });
  });

  it('treats an expired key as new (TTL elapsed)', async () => {
    const store = createInMemoryIdempotencyStore({ ttlMs: 1000 });
    await store.begin('k1', 'fp', 1000);
    await store.complete('k1', response, 1000);
    // Within TTL → replay; at/after TTL → reset to new.
    expect((await store.begin('k1', 'fp', 1999)).outcome).toBe('replay');
    expect(await store.begin('k1', 'fp', 2000)).toEqual({ outcome: 'new' });
  });

  it('completing an unknown key is a no-op (does not create a replayable record)', async () => {
    const store = createInMemoryIdempotencyStore();
    await store.complete('ghost', response, 1000);
    expect(await store.begin('ghost', 'fp', 1001)).toEqual({ outcome: 'new' });
  });
});
