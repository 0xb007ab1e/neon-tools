import { Pool } from 'pg';
import { assertPostgresTls } from '../../core/transport-security.js';
import type {
  PendingErasureRecord,
  PendingErasureStatus,
  PendingErasureStore,
} from '../../ports/pending-erasure-store.js';

/** A Postgres-backed {@link PendingErasureStore}, plus `close`. */
export interface PgPendingErasureStore extends PendingErasureStore {
  /** Release the connection pool. */
  close(): Promise<void>;
}

/** Options for {@link createPgPendingErasureStore}. */
export interface PgPendingErasureStoreOptions {
  /** Control-plane Postgres connection string (the `tf_pending_erasures` table lives here). */
  connectionString: string;
  /** Max pool size. */
  maxConnections?: number;
  /** Permit a non-TLS connection (local dev only — the documented leaky-endpoint opt-out). */
  allowInsecure?: boolean;
}

interface Row {
  id: string;
  tenant_id: string;
  status: PendingErasureStatus;
  tenant_email: string | null;
  reason: string | null;
  requested_at: Date;
  execute_at: Date;
}

/** Map a DB row to a {@link PendingErasureRecord} (omitting null/cleared optionals). */
function toRecord(r: Row): PendingErasureRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    status: r.status,
    requestedAt: r.requested_at.toISOString(),
    executeAt: r.execute_at.toISOString(),
    // `tenant_email`/`reason` are PII/audit data that the terminal transition clears to NULL (L3);
    // omit the optional fields entirely when absent so the record shape matches the in-memory store.
    ...(r.tenant_email !== null ? { tenantEmail: r.tenant_email } : {}),
    ...(r.reason !== null ? { reason: r.reason } : {}),
  };
}

/** Columns selected for every read (explicit list — no `SELECT *`). */
const COLUMNS = 'id, tenant_id, status, tenant_email, reason, requested_at, execute_at';

/**
 * Create a {@link PendingErasureStore} backed by Neon Postgres (`tf_pending_erasures`, migration
 * 0012) — **durable across restarts and atomic across replicas**. This is the operational
 * prerequisite for enabling the portal's destructive self-serve actions in a multi-replica /
 * restart-sensitive production deployment (threat-model B8w / red-team F2, ADR-0010): the
 * in-memory adapter's single-winner cancel/claim invariant only holds within one single-threaded
 * process, whereas here each flip is a **single conditional `UPDATE … WHERE status='pending'`** whose
 * rowcount decides the winner — so a cancel that races the executor across two replicas still cannot
 * both win the same `pending` row, and a redelivered claim of a non-`pending` record is a no-op.
 *
 * Holds no secrets. `tenant_email` (PII captured at request time) and `reason` (audit) are cleared to
 * NULL on the terminal (`done`/`cancelled`) transition — data minimization (review L3, master §5).
 *
 * @param options - Connection string and optional pool size / TLS opt-out.
 * @returns A Postgres-backed pending-erasure store.
 */
export function createPgPendingErasureStore(
  options: PgPendingErasureStoreOptions,
): PgPendingErasureStore {
  assertPostgresTls(options.connectionString, 'DATABASE_URL', options.allowInsecure);
  const pool = new Pool({
    connectionString: options.connectionString,
    ...(options.maxConnections === undefined ? {} : { max: options.maxConnections }),
  });
  return {
    async create(record: PendingErasureRecord): Promise<PendingErasureRecord | null> {
      // One in-flight request per tenant. The partial unique index
      // (`tf_pending_erasures_active_tenant_idx WHERE status IN ('pending','processing')`) enforces
      // this **in the DB across replicas**: a second active insert for the same tenant raises a unique
      // violation (SQLSTATE 23505), which we map to `null` ("an active request already exists") to
      // match the in-memory contract. A prior **terminal** row for the tenant doesn't conflict (it's
      // outside the partial index), so a fresh request after cancel/done is allowed.
      try {
        const { rows } = await pool.query<Row>(
          `INSERT INTO tf_pending_erasures
             (id, tenant_id, status, tenant_email, reason, requested_at, execute_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING ${COLUMNS}`,
          [
            record.id,
            record.tenantId,
            record.status,
            record.tenantEmail ?? null,
            record.reason ?? null,
            record.requestedAt,
            record.executeAt,
          ],
        );
        return rows[0] ? toRecord(rows[0]) : null;
      } catch (error) {
        if (isUniqueViolation(error)) return null;
        throw error;
      }
    },

    async getActive(tenantId: string): Promise<PendingErasureRecord | null> {
      const { rows } = await pool.query<Row>(
        `SELECT ${COLUMNS} FROM tf_pending_erasures
         WHERE tenant_id = $1 AND status IN ('pending', 'processing')
         LIMIT 1`,
        [tenantId],
      );
      return rows[0] ? toRecord(rows[0]) : null;
    },

    async cancel(tenantId: string): Promise<PendingErasureRecord | null> {
      // Atomic single-winner flip pending → cancelled, **and** clear PII in the same statement (L3).
      // The `WHERE status='pending'` guard means a row already flipped to `processing` by the
      // executor (possibly on another replica) updates zero rows → we return null ("cannot cancel").
      const { rows } = await pool.query<Row>(
        `UPDATE tf_pending_erasures
           SET status = 'cancelled', tenant_email = NULL, reason = NULL, updated_at = now()
         WHERE tenant_id = $1 AND status = 'pending'
         RETURNING ${COLUMNS}`,
        [tenantId],
      );
      return rows[0] ? toRecord(rows[0]) : null;
    },

    async claimForProcessing(id: string): Promise<PendingErasureRecord | null> {
      // Atomic single-winner flip pending → processing — the one point that gates destruction. The
      // conditional UPDATE updates exactly one row iff it was still `pending`; a cancel that won first
      // (or an at-least-once redelivery of a non-pending record) updates zero rows → null, and the
      // executor must then ack and exit without erasing. This is the cross-replica at-most-once
      // guarantee: two replicas issuing this UPDATE concurrently — Postgres serializes the row write,
      // so exactly one sees `status='pending'` and returns the row; the other sees it already
      // `processing` and matches zero rows.
      const { rows } = await pool.query<Row>(
        `UPDATE tf_pending_erasures
           SET status = 'processing', updated_at = now()
         WHERE id = $1 AND status = 'pending'
         RETURNING ${COLUMNS}`,
        [id],
      );
      return rows[0] ? toRecord(rows[0]) : null;
    },

    async markDone(id: string): Promise<void> {
      // Mark a processing record done and clear PII (L3). Idempotent — re-running on an already-`done`
      // row is a harmless no-op (the SET is the same and PII is already NULL).
      await pool.query(
        `UPDATE tf_pending_erasures
           SET status = 'done', tenant_email = NULL, reason = NULL, updated_at = now()
         WHERE id = $1`,
        [id],
      );
    },

    async listDue(nowMs: number, limit: number): Promise<PendingErasureRecord[]> {
      // The executor's work queue: due `pending` rows, earliest window first. Bounded by `limit`
      // (no unbounded result set — DoS control). Uses the (status, execute_at) index.
      const { rows } = await pool.query<Row>(
        `SELECT ${COLUMNS} FROM tf_pending_erasures
         WHERE status = 'pending' AND execute_at <= $1
         ORDER BY execute_at ASC
         LIMIT $2`,
        [new Date(nowMs).toISOString(), limit],
      );
      return rows.map(toRecord);
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}

/** Is this error a Postgres unique-constraint violation (SQLSTATE 23505)? */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}
