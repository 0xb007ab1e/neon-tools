import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgTenantRegistry } from '../../src/adapters/neon-pg/registry.js';
import { createPgPendingErasureStore } from '../../src/adapters/neon-pg/pending-erasure-store.js';
import type { PendingErasureRecord } from '../../src/ports/pending-erasure-store.js';

// Non-hermetic: needs a live control-plane Postgres (no Neon API). Self-skips without DATABASE_URL.
// Proves the cross-replica guarantees that the in-memory adapter only gives within one process: the
// atomic single-winner cancel/claim flips, PII clearing on terminal transitions, due-scan filtering,
// and durability — the operational prerequisite (threat-model B8w / red-team F2, ADR-0010) for the
// portal's destructive self-serve flag in multi-replica / restart-sensitive production.
const databaseUrl = process.env.DATABASE_URL;
const ready = Boolean(databaseUrl);

describe.skipIf(!ready)('pg pending-erasure store (live Postgres)', () => {
  const registry = createPgTenantRegistry({ connectionString: databaseUrl! });
  const store = createPgPendingErasureStore({ connectionString: databaseUrl! });
  const cleanup = new Pool({ connectionString: databaseUrl! });
  const tag = Date.now().toString(36);
  const slugPrefix = `pe-${tag}`;
  const idPrefix = `pe-${tag}`;

  /** Create a tenant row directly and return its generated UUID (FK target for the erasure rows). */
  async function makeTenant(suffix: string): Promise<string> {
    const { rows } = await cleanup.query<{ id: string }>(
      `INSERT INTO tf_tenants (slug, region, status) VALUES ($1, 'aws-us-east-2', 'active')
       RETURNING id`,
      [`${slugPrefix}-${suffix}`],
    );
    return rows[0]!.id;
  }

  const rec = (over: Partial<PendingErasureRecord> & { id: string; tenantId: string }) => ({
    requestedAt: '2026-06-24T00:00:00.000Z',
    executeAt: '2026-06-26T00:00:00.000Z',
    status: 'pending' as const,
    ...over,
  });

  beforeAll(async () => {
    await registry.migrate(); // ensures tf_pending_erasures (migration 0012)
    // Order matters: erasure rows FK tf_tenants, so clear them before the tenants.
    await cleanup.query(`DELETE FROM tf_pending_erasures WHERE id LIKE $1`, [`${idPrefix}%`]);
    await cleanup.query(`DELETE FROM tf_tenants WHERE slug LIKE $1`, [`${slugPrefix}%`]);
  });

  afterAll(async () => {
    await cleanup.query(`DELETE FROM tf_pending_erasures WHERE id LIKE $1`, [`${idPrefix}%`]);
    await cleanup.query(`DELETE FROM tf_tenants WHERE slug LIKE $1`, [`${slugPrefix}%`]);
    await cleanup.end();
    await store.close();
    await registry.close();
  });

  it('creates a pending record, reports it active, and persists across a fresh instance (durability)', async () => {
    const tenantId = await makeTenant('create');
    const id = `${idPrefix}-create`;
    expect(await store.create(rec({ id, tenantId }))).not.toBeNull();
    // A brand-new store instance (simulating another replica / a restart) reads it from the DB.
    const other = createPgPendingErasureStore({ connectionString: databaseUrl! });
    try {
      const active = await other.getActive(tenantId);
      expect(active?.id).toBe(id);
      expect(active?.status).toBe('pending');
    } finally {
      await other.close();
    }
  });

  it('refuses a second active request for the same tenant (one in-flight, enforced in the DB)', async () => {
    const tenantId = await makeTenant('one-inflight');
    expect(await store.create(rec({ id: `${idPrefix}-of1`, tenantId }))).not.toBeNull();
    expect(await store.create(rec({ id: `${idPrefix}-of2`, tenantId }))).toBeNull();
  });

  it('allows a fresh request after the prior one reaches a terminal state', async () => {
    const tenantId = await makeTenant('after-terminal');
    await store.create(rec({ id: `${idPrefix}-at1`, tenantId }));
    expect(await store.cancel(tenantId, 0)).not.toBeNull(); // → cancelled (terminal)
    // Outside the partial unique index now, so a new active request is permitted.
    expect(await store.create(rec({ id: `${idPrefix}-at2`, tenantId }))).not.toBeNull();
  });

  it('two concurrent claimForProcessing(id) across instances → exactly one wins (cross-replica at-most-once)', async () => {
    const tenantId = await makeTenant('concurrent-claim');
    const id = `${idPrefix}-claim`;
    await store.create(rec({ id, tenantId }));
    // Two independent store instances = two replicas issuing the conditional UPDATE concurrently.
    const a = createPgPendingErasureStore({ connectionString: databaseUrl! });
    const b = createPgPendingErasureStore({ connectionString: databaseUrl! });
    try {
      const [r1, r2] = await Promise.all([a.claimForProcessing(id), b.claimForProcessing(id)]);
      const winners = [r1, r2].filter((r) => r !== null);
      const losers = [r1, r2].filter((r) => r === null);
      expect(winners).toHaveLength(1); // exactly one replica claimed it
      expect(losers).toHaveLength(1); // the other matched zero rows → null (must not erase)
      expect(winners[0]?.status).toBe('processing');
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('cancel racing a claim is single-winner (no double-action on one pending row)', async () => {
    // claim-first → cancel must lose.
    const t1 = await makeTenant('race-claim-first');
    const id1 = `${idPrefix}-rcf`;
    await store.create(rec({ id: id1, tenantId: t1 }));
    const a = createPgPendingErasureStore({ connectionString: databaseUrl! });
    const b = createPgPendingErasureStore({ connectionString: databaseUrl! });
    try {
      expect(await a.claimForProcessing(id1)).not.toBeNull(); // executor won
      expect(await b.cancel(t1, 0)).toBeNull(); // cancel loses → "cannot cancel"
    } finally {
      await a.close();
      await b.close();
    }

    // cancel-first → claim must lose (no delete after a successful cancel).
    const t2 = await makeTenant('race-cancel-first');
    const id2 = `${idPrefix}-rcf2`;
    await store.create(rec({ id: id2, tenantId: t2 }));
    const c = createPgPendingErasureStore({ connectionString: databaseUrl! });
    const d = createPgPendingErasureStore({ connectionString: databaseUrl! });
    try {
      expect(await c.cancel(t2, 0)).not.toBeNull(); // cancel won
      expect(await d.claimForProcessing(id2)).toBeNull(); // executor loses → no delete
    } finally {
      await c.close();
      await d.close();
    }
  });

  it('cancel clears tenant_email + reason in the DB but keeps the terminal status/ids (L3)', async () => {
    const tenantId = await makeTenant('cancel-pii');
    const id = `${idPrefix}-cancel-pii`;
    await store.create(rec({ id, tenantId, tenantEmail: 'a@example.com', reason: 'gdpr-art17' }));
    const cancelled = await store.cancel(tenantId, 0);
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.tenantEmail).toBeUndefined(); // returned record carries no PII
    expect(cancelled?.reason).toBeUndefined();
    // …and the stored columns are NULL (verify in the DB directly, not just via the mapper).
    const { rows } = await cleanup.query<{ tenant_email: string | null; reason: string | null }>(
      `SELECT tenant_email, reason FROM tf_pending_erasures WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.tenant_email).toBeNull();
    expect(rows[0]?.reason).toBeNull();
  });

  it('markDone clears tenant_email + reason in the DB but keeps the terminal record (L3)', async () => {
    const tenantId = await makeTenant('done-pii');
    const id = `${idPrefix}-done-pii`;
    await store.create(rec({ id, tenantId, tenantEmail: 'b@example.com', reason: 'gdpr-art17' }));
    const claimed = await store.claimForProcessing(id);
    expect(claimed?.tenantEmail).toBe('b@example.com'); // executor reads PII from the claimed snapshot
    await store.markDone(id);
    const { rows } = await cleanup.query<{
      status: string;
      tenant_id: string;
      tenant_email: string | null;
      reason: string | null;
    }>(`SELECT status, tenant_id, tenant_email, reason FROM tf_pending_erasures WHERE id = $1`, [
      id,
    ]);
    expect(rows[0]?.status).toBe('done'); // terminal record retained for audit
    expect(rows[0]?.tenant_id).toBe(tenantId);
    expect(rows[0]?.tenant_email).toBeNull(); // PII dropped — purpose-spent
    expect(rows[0]?.reason).toBeNull();
    // The claimed snapshot is independent of the cleared stored row (alert intact).
    expect(claimed?.tenantEmail).toBe('b@example.com');
  });

  it('markDone is idempotent on an already-done record (no-op)', async () => {
    const tenantId = await makeTenant('done-idem');
    const id = `${idPrefix}-done-idem`;
    await store.create(rec({ id, tenantId }));
    await store.claimForProcessing(id);
    await store.markDone(id);
    await expect(store.markDone(id)).resolves.toBeUndefined(); // safe to re-run
  });

  it('listDue returns only due pending rows, earliest first, bounded by limit', async () => {
    const tEarly = await makeTenant('due-early');
    const tLate = await makeTenant('due-late');
    const tFuture = await makeTenant('due-future');
    const tCancelled = await makeTenant('due-cancelled');
    await store.create(
      rec({ id: `${idPrefix}-due-late`, tenantId: tLate, executeAt: '2026-06-26T00:00:00.000Z' }),
    );
    await store.create(
      rec({ id: `${idPrefix}-due-early`, tenantId: tEarly, executeAt: '2026-06-25T00:00:00.000Z' }),
    );
    await store.create(
      rec({
        id: `${idPrefix}-due-future`,
        tenantId: tFuture,
        executeAt: '2026-07-01T00:00:00.000Z',
      }),
    );
    // A cancelled row with a due window must be excluded (status filter).
    await store.create(
      rec({
        id: `${idPrefix}-due-cancelled`,
        tenantId: tCancelled,
        executeAt: '2026-06-25T00:00:00.000Z',
      }),
    );
    await store.cancel(tCancelled, 0);

    const now = Date.parse('2026-06-27T00:00:00.000Z');
    const due = await store.listDue(now, 50);
    const ids = due.map((r) => r.id);
    // Only our two due+pending rows, earliest window first. (Filter to our tag to ignore any other
    // rows that may exist in a shared dev DB.)
    const ours = ids.filter((i) => i.startsWith(`${idPrefix}-due-`));
    expect(ours).toEqual([`${idPrefix}-due-early`, `${idPrefix}-due-late`]);
    expect(ours).not.toContain(`${idPrefix}-due-future`); // window not yet elapsed
    expect(ours).not.toContain(`${idPrefix}-due-cancelled`); // not pending

    // limit bounds the result set.
    const limited = (await store.listDue(now, 1)).filter((r) =>
      r.id.startsWith(`${idPrefix}-due-`),
    );
    expect(limited.length).toBeLessThanOrEqual(1);
  });
});
