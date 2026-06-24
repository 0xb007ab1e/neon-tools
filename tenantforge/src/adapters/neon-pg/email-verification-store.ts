import { Pool } from 'pg';
import { assertPostgresTls } from '../../core/transport-security.js';
import type { EmailVerificationRecord } from '../../core/index.js';
import type { EmailVerificationStore } from '../../ports/email-verification-store.js';

/** A Postgres-backed {@link EmailVerificationStore}, plus `close`. */
export interface PgEmailVerificationStore extends EmailVerificationStore {
  /** Release the connection pool. */
  close(): Promise<void>;
}

/** Options for {@link createPgEmailVerificationStore}. */
export interface PgEmailVerificationStoreOptions {
  /** Control-plane Postgres connection string (the `tf_email_verifications` table lives here). */
  connectionString: string;
  /** Max pool size. */
  maxConnections?: number;
  /** Permit a non-TLS connection (local dev only — the documented leaky-endpoint opt-out). */
  allowInsecure?: boolean;
}

interface Row {
  email: string;
  code_hash: string;
  expires_at: Date;
  attempts: number;
  verified_at: Date | null;
  created_at: Date;
}

/** Map a DB row to an {@link EmailVerificationRecord} (omitting null optionals). */
function toRecord(r: Row): EmailVerificationRecord {
  return {
    email: r.email,
    codeHash: r.code_hash,
    expiresAt: r.expires_at.toISOString(),
    attempts: r.attempts,
    ...(r.verified_at !== null ? { verifiedAt: r.verified_at.toISOString() } : {}),
    createdAt: r.created_at.toISOString(),
  };
}

/**
 * Create an {@link EmailVerificationStore} backed by Neon Postgres (`tf_email_verifications`,
 * migration 0010) — durable + cross-instance. Stores only the code hash. No new dependencies (`pg`).
 * `put` upserts on the email PK so re-issuing a code supersedes the prior one and resets its state.
 *
 * @param options - Connection string and optional pool size / TLS opt-out.
 * @returns A Postgres-backed email-verification store.
 */
export function createPgEmailVerificationStore(
  options: PgEmailVerificationStoreOptions,
): PgEmailVerificationStore {
  assertPostgresTls(options.connectionString, 'DATABASE_URL', options.allowInsecure);
  const pool = new Pool({
    connectionString: options.connectionString,
    ...(options.maxConnections === undefined ? {} : { max: options.maxConnections }),
  });
  return {
    async put(record: EmailVerificationRecord): Promise<void> {
      await pool.query(
        `INSERT INTO tf_email_verifications (email, code_hash, expires_at, attempts, verified_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (email) DO UPDATE SET
           code_hash = EXCLUDED.code_hash,
           expires_at = EXCLUDED.expires_at,
           attempts = EXCLUDED.attempts,
           verified_at = EXCLUDED.verified_at,
           created_at = EXCLUDED.created_at`,
        [
          record.email,
          record.codeHash,
          record.expiresAt,
          record.attempts,
          record.verifiedAt ?? null,
          record.createdAt,
        ],
      );
    },
    async get(email: string): Promise<EmailVerificationRecord | null> {
      const { rows } = await pool.query<Row>(
        `SELECT * FROM tf_email_verifications WHERE email = $1`,
        [email],
      );
      return rows[0] ? toRecord(rows[0]) : null;
    },
    async recordFailedAttempt(email: string): Promise<number> {
      const { rows } = await pool.query<{ attempts: number }>(
        `UPDATE tf_email_verifications SET attempts = attempts + 1 WHERE email = $1 RETURNING attempts`,
        [email],
      );
      return rows[0]?.attempts ?? 0;
    },
    async markVerified(email: string, verifiedAt: string): Promise<void> {
      await pool.query(`UPDATE tf_email_verifications SET verified_at = $2 WHERE email = $1`, [
        email,
        verifiedAt,
      ]);
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
