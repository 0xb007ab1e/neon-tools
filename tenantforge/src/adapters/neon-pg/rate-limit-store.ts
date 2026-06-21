import { Pool } from 'pg';
import { assertPostgresTls } from '../../core/transport-security.js';
import type { RateLimitHit, RateLimitStore } from '../../ports/rate-limit-store.js';

/** A Postgres-backed {@link RateLimitStore}, plus `close`. */
export interface PgRateLimitStore extends RateLimitStore {
  /** Release the connection pool. */
  close(): Promise<void>;
}

/** Options for {@link createPgRateLimitStore}. */
export interface PgRateLimitStoreOptions {
  /** Control-plane Postgres connection string (the `tf_rate_limits` table lives here). */
  connectionString: string;
  /** Max pool size. */
  maxConnections?: number;
  /** Permit a non-TLS connection (local dev only — the documented leaky-endpoint opt-out). */
  allowInsecure?: boolean;
}

/**
 * Create a {@link RateLimitStore} backed by Neon Postgres (`tf_rate_limits`, migration 0004) — the
 * Neon-native, **cross-instance** limiter (threat-model R2). The count is shared by every replica, so
 * a per-principal limit is global rather than per-replica.
 *
 * `increment` is a single atomic upsert: within the same aligned window the count is bumped; when the
 * window rolls over it resets to 1. No new dependencies — reuses `pg`.
 *
 * @param options - Connection string and optional pool size.
 * @returns A Postgres-backed rate-limit store.
 */
export function createPgRateLimitStore(options: PgRateLimitStoreOptions): PgRateLimitStore {
  assertPostgresTls(options.connectionString, 'DATABASE_URL', options.allowInsecure);
  const pool = new Pool({
    connectionString: options.connectionString,
    ...(options.maxConnections === undefined ? {} : { max: options.maxConnections }),
  });

  return {
    async increment(key: string, windowMs: number, nowMs: number): Promise<RateLimitHit> {
      const startMs = Math.floor(nowMs / windowMs) * windowMs;
      const { rows } = await pool.query<{ count: number; window_start_ms: string }>(
        `INSERT INTO tf_rate_limits (key, window_start_ms, count) VALUES ($1, $2, 1)
         ON CONFLICT (key) DO UPDATE SET
           count = CASE WHEN tf_rate_limits.window_start_ms = EXCLUDED.window_start_ms
                        THEN tf_rate_limits.count + 1 ELSE 1 END,
           window_start_ms = EXCLUDED.window_start_ms
         RETURNING count, window_start_ms`,
        [key, startMs],
      );
      return { count: rows[0]!.count, windowStartMs: Number(rows[0]!.window_start_ms) };
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
