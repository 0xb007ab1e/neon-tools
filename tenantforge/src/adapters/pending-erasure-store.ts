import type { PendingErasureRecord, PendingErasureStore } from '../ports/pending-erasure-store.js';

/** An in-memory {@link PendingErasureStore} (default / tests), plus a `clear` test helper. */
export interface InMemoryPendingErasureStore extends PendingErasureStore {
  /** Drop all stored requests (test helper). */
  clear(): void;
}

/** Is this record an **active** (cancellable / runnable) erasure? */
function isActive(r: PendingErasureRecord): boolean {
  return r.status === 'pending' || r.status === 'processing';
}

/**
 * Create an in-memory {@link PendingErasureStore} — process-local, for dev / single-instance / tests.
 *
 * The single-threaded event loop is what makes the conditional flips atomic: {@link cancel} and
 * {@link claimForProcessing} each read-check-mutate **without an intervening await**, so a cancel and
 * an execute that race can never both win the same `pending` record — exactly the invariant that
 * prevents a redelivered/raced erasure command from deleting after a successful cancel (threat-model
 * B8w / red-team F2). A Postgres-backed adapter achieves the same with a single conditional
 * `UPDATE … WHERE status='pending'` and a rowcount check.
 *
 * @returns The in-memory pending-erasure store.
 */
export function createInMemoryPendingErasureStore(): InMemoryPendingErasureStore {
  const byId = new Map<string, PendingErasureRecord>();

  const findActive = (tenantId: string): PendingErasureRecord | undefined => {
    for (const r of byId.values()) if (r.tenantId === tenantId && isActive(r)) return r;
    return undefined;
  };

  return {
    create(record: PendingErasureRecord): Promise<PendingErasureRecord | null> {
      // One in-flight request per tenant: refuse when an active one already exists.
      if (findActive(record.tenantId) !== undefined) return Promise.resolve(null);
      byId.set(record.id, { ...record });
      return Promise.resolve({ ...record });
    },

    getActive(tenantId: string): Promise<PendingErasureRecord | null> {
      const r = findActive(tenantId);
      return Promise.resolve(r ? { ...r } : null);
    },

    cancel(tenantId: string): Promise<PendingErasureRecord | null> {
      // Atomic flip pending → cancelled. If the active record is already `processing` (the executor
      // won the race), cancel loses — return null so the caller reports "cannot cancel".
      const r = findActive(tenantId);
      if (r === undefined || r.status !== 'pending') return Promise.resolve(null);
      r.status = 'cancelled';
      return Promise.resolve({ ...r });
    },

    claimForProcessing(id: string): Promise<PendingErasureRecord | null> {
      // Atomic flip pending → processing. Only the winner proceeds to erase; a redelivery (record no
      // longer `pending`) returns null → the executor acks and exits without re-deleting.
      const r = byId.get(id);
      if (r === undefined || r.status !== 'pending') return Promise.resolve(null);
      r.status = 'processing';
      return Promise.resolve({ ...r });
    },

    markDone(id: string): Promise<void> {
      const r = byId.get(id);
      if (r !== undefined) r.status = 'done';
      return Promise.resolve();
    },

    listDue(nowMs: number, limit: number): Promise<PendingErasureRecord[]> {
      const due = [...byId.values()]
        .filter((r) => r.status === 'pending' && Date.parse(r.executeAt) <= nowMs)
        .sort((a, b) => (a.executeAt < b.executeAt ? -1 : a.executeAt > b.executeAt ? 1 : 0))
        .slice(0, limit)
        .map((r) => ({ ...r }));
      return Promise.resolve(due);
    },

    clear(): void {
      byId.clear();
    },
  };
}
