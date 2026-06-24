import type { PendingErasureRecord, PendingErasureStore } from '../ports/pending-erasure-store.js';

/** An in-memory {@link PendingErasureStore} (default / tests), plus `clear`/`peek` test helpers. */
export interface InMemoryPendingErasureStore extends PendingErasureStore {
  /** Drop all stored requests (test helper). */
  clear(): void;
  /**
   * Return a copy of the record by id **regardless of status** (incl. terminal `done`/`cancelled`) —
   * a test helper to assert PII is cleared on terminal records (the production port only exposes
   * *active* records via {@link PendingErasureStore.getActive}). Not part of the port.
   *
   * @param id - The request id.
   * @returns A copy of the record, or `null` if unknown.
   */
  peek(id: string): PendingErasureRecord | null;
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
      // Terminal state: drop PII (review L3 — data minimization, master §5 / std-privacy). The email +
      // reason served the in-flight request; once cancelled they're past their purpose. Keep the
      // structural fields (ids/timestamps/status) for audit/history. PG mirror:
      // `UPDATE … SET status='cancelled', tenant_email=NULL, reason=NULL WHERE id=? AND status='pending'`.
      delete r.tenantEmail;
      delete r.reason;
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
      if (r !== undefined) {
        r.status = 'done';
        // Terminal state: drop PII (review L3 — data minimization, master §5 / std-privacy). The
        // erasure has run; the captured email + reason are now purpose-spent and must not linger on
        // the very record whose job was to erase this tenant. Keep ids/timestamps/status for audit.
        // The executor already read these from its CLAIMED snapshot (before markDone), so clearing
        // here can't affect the alert/cert. PG mirror:
        // `UPDATE … SET status='done', tenant_email=NULL, reason=NULL WHERE id=?`.
        delete r.tenantEmail;
        delete r.reason;
      }
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

    peek(id: string): PendingErasureRecord | null {
      const r = byId.get(id);
      return r ? { ...r } : null;
    },
  };
}
