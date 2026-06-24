import { Pool } from 'pg';
import { assertPostgresTls } from '../../core/transport-security.js';
import type { SignupRequestRecord, SignupRequestStatus } from '../../core/index.js';
import type { SignupRequestPatch, SignupRequestStore } from '../../ports/signup-request-store.js';

/** A Postgres-backed {@link SignupRequestStore}, plus `close`. */
export interface PgSignupRequestStore extends SignupRequestStore {
  /** Release the connection pool. */
  close(): Promise<void>;
}

/** Options for {@link createPgSignupRequestStore}. */
export interface PgSignupRequestStoreOptions {
  /** Control-plane Postgres connection string (the `tf_signup_requests` table lives here). */
  connectionString: string;
  /** Max pool size. */
  maxConnections?: number;
  /** Permit a non-TLS connection (local dev only — the documented leaky-endpoint opt-out). */
  allowInsecure?: boolean;
}

interface Row {
  id: string;
  email: string;
  status: SignupRequestStatus;
  customer_ref: string | null;
  setup_intent_id: string | null;
  slug: string | null;
  region: string | null;
  plan_id: string | null;
  tenant_id: string | null;
  connection_revealed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Map a DB row to a {@link SignupRequestRecord} (omitting null optionals). */
function toRecord(r: Row): SignupRequestRecord {
  return {
    id: r.id,
    email: r.email,
    status: r.status,
    ...(r.customer_ref !== null ? { customerRef: r.customer_ref } : {}),
    ...(r.setup_intent_id !== null ? { setupIntentId: r.setup_intent_id } : {}),
    ...(r.slug !== null ? { slug: r.slug } : {}),
    ...(r.region !== null ? { region: r.region } : {}),
    ...(r.plan_id !== null ? { planId: r.plan_id } : {}),
    ...(r.tenant_id !== null ? { tenantId: r.tenant_id } : {}),
    ...(r.connection_revealed_at !== null
      ? { connectionRevealedAt: r.connection_revealed_at.toISOString() }
      : {}),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/** Map a {@link SignupRequestPatch} field name to its DB column (allow-list — no dynamic SQL injection). */
const COLUMN: Record<keyof SignupRequestPatch, string> = {
  status: 'status',
  customerRef: 'customer_ref',
  setupIntentId: 'setup_intent_id',
  slug: 'slug',
  region: 'region',
  planId: 'plan_id',
  tenantId: 'tenant_id',
  connectionRevealedAt: 'connection_revealed_at',
  updatedAt: 'updated_at',
};

/**
 * Create a {@link SignupRequestStore} backed by Neon Postgres (`tf_signup_requests`, migration 0011) —
 * durable + cross-instance. Holds no secrets. `update` builds a parameterized `SET` from an
 * allow-listed column map (never interpolates field names) so it is injection-safe.
 *
 * @param options - Connection string and optional pool size / TLS opt-out.
 * @returns A Postgres-backed signup-request store.
 */
export function createPgSignupRequestStore(
  options: PgSignupRequestStoreOptions,
): PgSignupRequestStore {
  assertPostgresTls(options.connectionString, 'DATABASE_URL', options.allowInsecure);
  const pool = new Pool({
    connectionString: options.connectionString,
    ...(options.maxConnections === undefined ? {} : { max: options.maxConnections }),
  });
  return {
    async create(record: SignupRequestRecord): Promise<void> {
      await pool.query(
        `INSERT INTO tf_signup_requests (id, email, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [record.id, record.email, record.status, record.createdAt, record.updatedAt],
      );
    },
    async get(id: string): Promise<SignupRequestRecord | null> {
      const { rows } = await pool.query<Row>(`SELECT * FROM tf_signup_requests WHERE id = $1`, [
        id,
      ]);
      return rows[0] ? toRecord(rows[0]) : null;
    },
    async update(id: string, patch: SignupRequestPatch): Promise<void> {
      const keys = Object.keys(patch) as (keyof SignupRequestPatch)[];
      if (keys.length === 0) return;
      const sets = keys.map((k, i) => `${COLUMN[k]} = $${i + 2}`);
      const values = keys.map((k) => patch[k] ?? null);
      await pool.query(`UPDATE tf_signup_requests SET ${sets.join(', ')} WHERE id = $1`, [
        id,
        ...values,
      ]);
    },
    async list(limit: number): Promise<SignupRequestRecord[]> {
      const { rows } = await pool.query<Row>(
        `SELECT * FROM tf_signup_requests ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );
      return rows.map(toRecord);
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
