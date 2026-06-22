import { Pool } from 'pg';
import { assertPostgresTls } from '../../core/transport-security.js';
import type { WebhookSubscriptionRecord } from '../../core/index.js';
import type { WebhookSubscriptionStore } from '../../ports/webhook-subscription-store.js';

/** A Postgres-backed {@link WebhookSubscriptionStore}, plus `close`. */
export interface PgWebhookSubscriptionStore extends WebhookSubscriptionStore {
  /** Release the connection pool. */
  close(): Promise<void>;
}

/** Options for {@link createPgWebhookSubscriptionStore}. */
export interface PgWebhookSubscriptionStoreOptions {
  /** Control-plane Postgres connection string (the `tf_webhook_subscriptions` table lives here). */
  connectionString: string;
  /** Max pool size. */
  maxConnections?: number;
  /** Permit a non-TLS connection (local dev only — the documented leaky-endpoint opt-out). */
  allowInsecure?: boolean;
}

interface Row {
  id: string;
  url: string;
  event_types: string[];
  active: boolean;
  created_at: Date;
}

/** Map a DB row to a {@link WebhookSubscriptionRecord}. */
function toRecord(r: Row): WebhookSubscriptionRecord {
  return {
    id: r.id,
    url: r.url,
    eventTypes: r.event_types,
    active: r.active,
    createdAt: r.created_at.toISOString(),
  };
}

/**
 * Create a {@link WebhookSubscriptionStore} backed by Neon Postgres (`tf_webhook_subscriptions`,
 * migration 0009) — durable + cross-instance. Metadata only; the signing secret lives in the
 * SecretStore. No new dependencies — reuses `pg`.
 *
 * @param options - Connection string and optional pool size / TLS opt-out.
 * @returns A Postgres-backed webhook-subscription store.
 */
export function createPgWebhookSubscriptionStore(
  options: PgWebhookSubscriptionStoreOptions,
): PgWebhookSubscriptionStore {
  assertPostgresTls(options.connectionString, 'DATABASE_URL', options.allowInsecure);
  const pool = new Pool({
    connectionString: options.connectionString,
    ...(options.maxConnections === undefined ? {} : { max: options.maxConnections }),
  });
  return {
    async create(record: WebhookSubscriptionRecord): Promise<void> {
      await pool.query(
        `INSERT INTO tf_webhook_subscriptions (id, url, event_types, active, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [record.id, record.url, record.eventTypes, record.active, record.createdAt],
      );
    },
    async findById(id: string): Promise<WebhookSubscriptionRecord | null> {
      const { rows } = await pool.query<Row>(
        `SELECT * FROM tf_webhook_subscriptions WHERE id = $1`,
        [id],
      );
      return rows[0] ? toRecord(rows[0]) : null;
    },
    async list(limit: number): Promise<WebhookSubscriptionRecord[]> {
      const { rows } = await pool.query<Row>(
        `SELECT * FROM tf_webhook_subscriptions ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );
      return rows.map(toRecord);
    },
    async delete(id: string): Promise<boolean> {
      const { rowCount } = await pool.query(`DELETE FROM tf_webhook_subscriptions WHERE id = $1`, [
        id,
      ]);
      return (rowCount ?? 0) > 0;
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
