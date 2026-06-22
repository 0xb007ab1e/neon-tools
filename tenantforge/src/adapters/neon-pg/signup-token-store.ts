import { Pool } from 'pg';
import { assertPostgresTls } from '../../core/transport-security.js';
import type { SignupTokenRecord } from '../../core/index.js';
import type { SignupTokenStore } from '../../ports/signup-token-store.js';

/** A Postgres-backed {@link SignupTokenStore}, plus `close`. */
export interface PgSignupTokenStore extends SignupTokenStore {
  /** Release the connection pool. */
  close(): Promise<void>;
}

/** Options for {@link createPgSignupTokenStore}. */
export interface PgSignupTokenStoreOptions {
  /** Control-plane Postgres connection string (the `tf_signup_tokens` table lives here). */
  connectionString: string;
  /** Max pool size. */
  maxConnections?: number;
  /** Permit a non-TLS connection (local dev only — the documented leaky-endpoint opt-out). */
  allowInsecure?: boolean;
}

interface Row {
  token_hash: string;
  slug: string;
  region: string | null;
  plan_id: string | null;
  expires_at: Date;
  redeemed_at: Date | null;
  redeemed_tenant_id: string | null;
  created_at: Date;
}

/** Map a DB row to a {@link SignupTokenRecord} (omitting null optionals). */
function toRecord(r: Row): SignupTokenRecord {
  return {
    tokenHash: r.token_hash,
    slug: r.slug,
    ...(r.region !== null ? { region: r.region } : {}),
    ...(r.plan_id !== null ? { planId: r.plan_id } : {}),
    expiresAt: r.expires_at.toISOString(),
    ...(r.redeemed_at !== null ? { redeemedAt: r.redeemed_at.toISOString() } : {}),
    ...(r.redeemed_tenant_id !== null ? { redeemedTenantId: r.redeemed_tenant_id } : {}),
    createdAt: r.created_at.toISOString(),
  };
}

/**
 * Create a {@link SignupTokenStore} backed by Neon Postgres (`tf_signup_tokens`, migration 0008) —
 * durable + cross-instance. Stores only the token hash. No new dependencies — reuses `pg`.
 *
 * @param options - Connection string and optional pool size / TLS opt-out.
 * @returns A Postgres-backed signup-token store.
 */
export function createPgSignupTokenStore(options: PgSignupTokenStoreOptions): PgSignupTokenStore {
  assertPostgresTls(options.connectionString, 'DATABASE_URL', options.allowInsecure);
  const pool = new Pool({
    connectionString: options.connectionString,
    ...(options.maxConnections === undefined ? {} : { max: options.maxConnections }),
  });
  return {
    async create(record: SignupTokenRecord): Promise<void> {
      await pool.query(
        `INSERT INTO tf_signup_tokens (token_hash, slug, region, plan_id, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          record.tokenHash,
          record.slug,
          record.region ?? null,
          record.planId ?? null,
          record.expiresAt,
          record.createdAt,
        ],
      );
    },
    async findByHash(tokenHash: string): Promise<SignupTokenRecord | null> {
      const { rows } = await pool.query<Row>(
        `SELECT * FROM tf_signup_tokens WHERE token_hash = $1`,
        [tokenHash],
      );
      return rows[0] ? toRecord(rows[0]) : null;
    },
    async markRedeemed(tokenHash: string, tenantId: string, redeemedAt: string): Promise<void> {
      await pool.query(
        `UPDATE tf_signup_tokens SET redeemed_at = $2, redeemed_tenant_id = $3 WHERE token_hash = $1`,
        [tokenHash, redeemedAt, tenantId],
      );
    },
    async list(limit: number): Promise<SignupTokenRecord[]> {
      const { rows } = await pool.query<Row>(
        `SELECT * FROM tf_signup_tokens ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );
      return rows.map(toRecord);
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
