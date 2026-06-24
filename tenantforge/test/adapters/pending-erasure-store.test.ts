import { describe, expect, it } from 'vitest';
import { createInMemoryPendingErasureStore } from '../../src/adapters/pending-erasure-store.js';
import type { PendingErasureRecord } from '../../src/ports/pending-erasure-store.js';

const rec = (over: Partial<PendingErasureRecord> = {}): PendingErasureRecord => ({
  id: 'e-1',
  tenantId: 't-a',
  requestedAt: '2026-06-24T00:00:00.000Z',
  executeAt: '2026-06-26T00:00:00.000Z',
  status: 'pending',
  reason: 'test',
  ...over,
});

describe('createInMemoryPendingErasureStore', () => {
  it('creates a pending record and reports it active', async () => {
    const store = createInMemoryPendingErasureStore();
    expect(await store.create(rec())).not.toBeNull();
    expect((await store.getActive('t-a'))?.status).toBe('pending');
  });

  it('refuses a second active request for the same tenant (one in-flight)', async () => {
    const store = createInMemoryPendingErasureStore();
    await store.create(rec());
    expect(await store.create(rec({ id: 'e-2' }))).toBeNull();
  });

  it('cancel wins the pending → cancelled flip', async () => {
    const store = createInMemoryPendingErasureStore();
    await store.create(rec());
    expect((await store.cancel('t-a', 0))?.status).toBe('cancelled');
    // No longer active; a fresh request is allowed.
    expect(await store.getActive('t-a')).toBeNull();
    expect(await store.create(rec({ id: 'e-2' }))).not.toBeNull();
  });

  it('claim wins the pending → processing flip', async () => {
    const store = createInMemoryPendingErasureStore();
    await store.create(rec());
    expect((await store.claimForProcessing('e-1'))?.status).toBe('processing');
  });

  it('cancel-vs-execute race: only one flip wins the same pending record', async () => {
    // Claim first → cancel must then lose (cannot delete after the executor claimed it, and vice
    // versa). This is the F2 invariant: no double-action on one pending row.
    const a = createInMemoryPendingErasureStore();
    await a.create(rec());
    expect(await a.claimForProcessing('e-1')).not.toBeNull(); // executor won
    expect(await a.cancel('t-a', 0)).toBeNull(); // cancel loses

    const b = createInMemoryPendingErasureStore();
    await b.create(rec());
    expect(await b.cancel('t-a', 0)).not.toBeNull(); // cancel won
    expect(await b.claimForProcessing('e-1')).toBeNull(); // executor loses → no delete
  });

  it('a redelivered claim of a non-pending record returns null (idempotent — ack & exit)', async () => {
    const store = createInMemoryPendingErasureStore();
    await store.create(rec());
    expect(await store.claimForProcessing('e-1')).not.toBeNull();
    // Second claim (at-least-once redelivery) wins nothing → executor must not re-delete.
    expect(await store.claimForProcessing('e-1')).toBeNull();
  });

  it('listDue returns only pending records whose window has elapsed', async () => {
    const store = createInMemoryPendingErasureStore();
    await store.create(rec({ id: 'e-1', tenantId: 't-a', executeAt: '2026-06-26T00:00:00.000Z' }));
    const before = Date.parse('2026-06-25T00:00:00.000Z');
    const after = Date.parse('2026-06-27T00:00:00.000Z');
    expect(await store.listDue(before, 10)).toHaveLength(0);
    expect(await store.listDue(after, 10)).toHaveLength(1);
  });

  it('listDue orders by executeAt (stable on ties) and clear() empties the store', async () => {
    const store = createInMemoryPendingErasureStore();
    await store.create(rec({ id: 'e-1', tenantId: 't-a', executeAt: '2026-06-26T00:00:00.000Z' }));
    await store.create(rec({ id: 'e-2', tenantId: 't-b', executeAt: '2026-06-25T00:00:00.000Z' }));
    await store.create(rec({ id: 'e-3', tenantId: 't-c', executeAt: '2026-06-25T00:00:00.000Z' }));
    const due = await store.listDue(Date.parse('2026-06-27T00:00:00.000Z'), 10);
    expect(due.map((r) => r.id)).toEqual(['e-2', 'e-3', 'e-1']); // earliest first; ties keep order
    store.clear();
    expect(await store.listDue(Date.parse('2026-06-27T00:00:00.000Z'), 10)).toHaveLength(0);
  });

  it('markDone moves a processing record to done', async () => {
    const store = createInMemoryPendingErasureStore();
    await store.create(rec());
    await store.claimForProcessing('e-1');
    await store.markDone('e-1');
    expect(await store.getActive('t-a')).toBeNull(); // done is terminal, not active
  });
});
