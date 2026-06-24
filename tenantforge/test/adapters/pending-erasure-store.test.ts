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

  it('carries the captured tenantEmail through create → getActive → listDue → claim (review L2)', async () => {
    // The email captured at request time must survive on the record so the executor can notify the
    // tenant after the record is gone — the field round-trips through every read.
    const store = createInMemoryPendingErasureStore();
    await store.create(rec({ tenantEmail: 'a@example.com' }));
    expect((await store.getActive('t-a'))?.tenantEmail).toBe('a@example.com');
    const due = await store.listDue(Date.parse('2026-06-27T00:00:00.000Z'), 10);
    expect(due[0]?.tenantEmail).toBe('a@example.com');
    expect((await store.claimForProcessing('e-1'))?.tenantEmail).toBe('a@example.com');
  });

  it('a record created without a tenantEmail leaves it undefined (operator-only alert path)', async () => {
    const store = createInMemoryPendingErasureStore();
    await store.create(rec());
    expect((await store.getActive('t-a'))?.tenantEmail).toBeUndefined();
  });

  it('markDone drops PII (tenantEmail + reason) but keeps the terminal status/ids (review L3)', async () => {
    const store = createInMemoryPendingErasureStore();
    await store.create(rec({ tenantEmail: 'a@example.com', reason: 'gdpr-art17' }));
    await store.claimForProcessing('e-1');
    await store.markDone('e-1');
    const after = store.peek('e-1');
    expect(after).not.toBeNull();
    expect(after!.status).toBe('done'); // status retained for audit/history
    expect(after!.id).toBe('e-1'); // structural fields retained
    expect(after!.tenantId).toBe('t-a');
    expect(after!.requestedAt).toBe('2026-06-24T00:00:00.000Z');
    expect(after!.tenantEmail).toBeUndefined(); // PII dropped — purpose-spent
    expect(after!.reason).toBeUndefined();
  });

  it('the claim snapshot keeps the email even after markDone clears the stored record (alert intact)', async () => {
    // L2 ordering proof: the executor reads tenantEmail from the CLAIMED snapshot (a copy) before
    // markDone; clearing the stored record on markDone must not retroactively blank that snapshot.
    const store = createInMemoryPendingErasureStore();
    await store.create(rec({ tenantEmail: 'a@example.com', reason: 'gdpr-art17' }));
    const claimed = await store.claimForProcessing('e-1');
    await store.markDone('e-1');
    expect(claimed!.tenantEmail).toBe('a@example.com'); // snapshot independent of the cleared record
    expect(store.peek('e-1')!.tenantEmail).toBeUndefined();
  });

  it('cancel drops PII (tenantEmail + reason) but keeps the terminal status/ids (review L3)', async () => {
    const store = createInMemoryPendingErasureStore();
    await store.create(rec({ tenantEmail: 'a@example.com', reason: 'gdpr-art17' }));
    const cancelled = await store.cancel('t-a', 0);
    expect(cancelled!.status).toBe('cancelled');
    expect(cancelled!.tenantEmail).toBeUndefined(); // returned record carries no PII
    expect(cancelled!.reason).toBeUndefined();
    // …and the stored record is likewise cleared.
    const after = store.peek('e-1');
    expect(after!.status).toBe('cancelled');
    expect(after!.tenantId).toBe('t-a');
    expect(after!.tenantEmail).toBeUndefined();
    expect(after!.reason).toBeUndefined();
  });
});
