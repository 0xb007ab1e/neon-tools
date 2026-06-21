import { Pool } from 'pg';
import { assertPostgresTls } from '../../core/transport-security.js';
import type { JsonObject } from '../../core/index.js';
import type { TenantEvent } from '../../core/observability.js';
import type { AuditLogStore, AuditQuery } from '../../ports/audit-log-store.js';

/** A Postgres-backed {@link AuditLogStore}, plus `close`. */
export interface PgAuditLogStore extends AuditLogStore {
  /** Release the connection pool. */
  close(): Promise<void>;
}

/** Options for {@link createPgAuditLogStore}. */
export interface PgAuditLogStoreOptions {
  /** Control-plane Postgres connection string (the `tf_audit_log` table lives here). */
  connectionString: string;
  /** Max pool size. */
  maxConnections?: number;
  /** Permit a non-TLS connection (local dev only — the documented leaky-endpoint opt-out). */
  allowInsecure?: boolean;
}

interface Row {
  event: string;
  at: Date;
  outcome: string;
  actor_id: string | null;
  actor_role: string | null;
  tenant_id: string | null;
  duration_ms: number | null;
  context: JsonObject | null;
  error: string | null;
}

/** Reassemble a stored row into a {@link TenantEvent} (optional fields omitted when null). */
function toEvent(row: Row): TenantEvent {
  return {
    event: row.event,
    at: row.at.toISOString(),
    outcome: row.outcome === 'error' ? 'error' : 'ok',
    ...(row.actor_id !== null ? { actor: { id: row.actor_id, role: row.actor_role ?? '' } } : {}),
    ...(row.tenant_id !== null ? { tenantId: row.tenant_id } : {}),
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    ...(row.context !== null ? { context: row.context } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
  };
}

/**
 * Create an {@link AuditLogStore} backed by Neon Postgres (`tf_audit_log`, migration 0006) — the
 * **cross-instance, durable** audit trail. No new dependencies — reuses `pg`. Append is a single
 * insert; query builds a bounded, newest-first `SELECT` from the optional event/tenant/since filters.
 *
 * @param options - Connection string and optional pool size.
 * @returns A Postgres-backed audit-log store.
 */
export function createPgAuditLogStore(options: PgAuditLogStoreOptions): PgAuditLogStore {
  assertPostgresTls(options.connectionString, 'DATABASE_URL', options.allowInsecure);
  const pool = new Pool({
    connectionString: options.connectionString,
    ...(options.maxConnections === undefined ? {} : { max: options.maxConnections }),
  });

  return {
    async append(event: TenantEvent): Promise<void> {
      await pool.query(
        `INSERT INTO tf_audit_log
           (event, at, outcome, actor_id, actor_role, tenant_id, duration_ms, context, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          event.event,
          event.at,
          event.outcome,
          event.actor?.id ?? null,
          event.actor?.role ?? null,
          event.tenantId ?? null,
          event.durationMs ?? null,
          event.context ?? null,
          event.error ?? null,
        ],
      );
    },

    async query(query: AuditQuery): Promise<TenantEvent[]> {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (query.events !== undefined) {
        params.push(query.events);
        conditions.push(`event = ANY($${params.length})`);
      }
      if (query.tenantId !== undefined) {
        params.push(query.tenantId);
        conditions.push(`tenant_id = $${params.length}`);
      }
      if (query.since !== undefined) {
        params.push(query.since);
        conditions.push(`at >= $${params.length}`);
      }
      params.push(query.limit);
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const { rows } = await pool.query<Row>(
        `SELECT event, at, outcome, actor_id, actor_role, tenant_id, duration_ms, context, error
         FROM tf_audit_log ${where} ORDER BY at DESC LIMIT $${params.length}`,
        params,
      );
      return rows.map(toEvent);
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
