import { Pool } from 'pg';
import type {
  IdempotencyBegin,
  IdempotencyStore,
  IdempotentResponse,
} from '../../ports/idempotency-store.js';

/** Default retention for an idempotency key: 24 hours. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** A Postgres-backed {@link IdempotencyStore}, plus `close`. */
export interface PgIdempotencyStore extends IdempotencyStore {
  /** Release the connection pool. */
  close(): Promise<void>;
}

/** Options for {@link createPgIdempotencyStore}. */
export interface PgIdempotencyStoreOptions {
  /** Control-plane Postgres connection string (the `tf_idempotency_keys` table lives here). */
  connectionString: string;
  /** Retention before a key is treated as new (default 24h). */
  ttlMs?: number;
  /** Max pool size. */
  maxConnections?: number;
}

interface Row {
  fingerprint: string;
  status: number | null;
  body: string | null;
  content_type: string | null;
}

/**
 * Create an {@link IdempotencyStore} backed by Neon Postgres (`tf_idempotency_keys`, migration
 * 0005) — the **cross-instance** store, so a retry that lands on a different replica still
 * de-duplicates. No new dependencies — reuses `pg`.
 *
 * `begin` reserves the key atomically with `INSERT ... ON CONFLICT DO NOTHING`; on conflict it
 * reads the existing row and classifies it (expired → reset to new; different fingerprint →
 * mismatch; no response yet → in-flight; else → replay).
 *
 * @param options - Connection string, optional TTL, and pool size.
 * @returns A Postgres-backed idempotency store.
 */
export function createPgIdempotencyStore(options: PgIdempotencyStoreOptions): PgIdempotencyStore {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const pool = new Pool({
    connectionString: options.connectionString,
    ...(options.maxConnections === undefined ? {} : { max: options.maxConnections }),
  });

  return {
    async begin(key: string, fingerprint: string, nowMs: number): Promise<IdempotencyBegin> {
      // Atomic reserve: only the first caller inserts (returns a row); others fall through to read.
      const inserted = await pool.query(
        `INSERT INTO tf_idempotency_keys (key, fingerprint, created_ms)
         VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING RETURNING key`,
        [key, fingerprint, nowMs],
      );
      if ((inserted.rowCount ?? 0) > 0) return { outcome: 'new' };

      const { rows } = await pool.query<Row>(
        `SELECT fingerprint, status, body, content_type, created_ms FROM tf_idempotency_keys
         WHERE key = $1`,
        [key],
      );
      const row = rows[0];
      if (row === undefined) return { outcome: 'new' }; // raced with an expiry sweep — treat as new

      const createdMs = Number((row as Row & { created_ms: string }).created_ms);
      if (nowMs - createdMs >= ttlMs) {
        // Expired: reset the reservation to the new request.
        await pool.query(
          `UPDATE tf_idempotency_keys
           SET fingerprint = $2, created_ms = $3, status = NULL, body = NULL, content_type = NULL
           WHERE key = $1`,
          [key, fingerprint, nowMs],
        );
        return { outcome: 'new' };
      }
      if (row.fingerprint !== fingerprint) return { outcome: 'mismatch' };
      if (row.status === null || row.body === null || row.content_type === null) {
        return { outcome: 'in_flight' };
      }
      return {
        outcome: 'replay',
        response: { status: row.status, body: row.body, contentType: row.content_type },
      };
    },

    async complete(key: string, response: IdempotentResponse, _nowMs: number): Promise<void> {
      await pool.query(
        `UPDATE tf_idempotency_keys SET status = $2, body = $3, content_type = $4 WHERE key = $1`,
        [key, response.status, response.body, response.contentType],
      );
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
