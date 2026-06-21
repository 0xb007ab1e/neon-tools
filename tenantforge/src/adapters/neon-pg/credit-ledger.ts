import { Pool } from 'pg';
import { assertPostgresTls } from '../../core/transport-security.js';
import type {
  CreditConsume,
  CreditEntry,
  CreditGrant,
  CreditLedger,
} from '../../ports/credit-ledger.js';

/** A Postgres-backed {@link CreditLedger}, plus `close`. */
export interface PgCreditLedger extends CreditLedger {
  /** Release the connection pool. */
  close(): Promise<void>;
}

/** Options for {@link createPgCreditLedger}. */
export interface PgCreditLedgerOptions {
  /** Control-plane Postgres connection string (the `tf_credits` table lives here). */
  connectionString: string;
  /** Max pool size. */
  maxConnections?: number;
  /** Permit a non-TLS connection (local dev only — the documented leaky-endpoint opt-out). */
  allowInsecure?: boolean;
}

interface Row {
  amount_minor: string;
  currency: string;
  reason: string;
  reference: string | null;
  created_at: Date;
}

/**
 * Create a {@link CreditLedger} backed by Neon Postgres (`tf_credits`, migration 0007) — durable and
 * cross-instance, the authoritative balance for billing. `consume` runs in a transaction under a
 * per-tenant **advisory lock** (so concurrent consumes for one tenant can't over-spend) and is
 * idempotent on `(tenant_id, currency, reference)` via the partial unique index (a re-charge for the
 * same period consumes nothing more). No new dependencies — reuses `pg`.
 *
 * @param options - Connection string and optional pool size / TLS opt-out.
 * @returns A Postgres-backed credit ledger.
 */
export function createPgCreditLedger(options: PgCreditLedgerOptions): PgCreditLedger {
  assertPostgresTls(options.connectionString, 'DATABASE_URL', options.allowInsecure);
  const pool = new Pool({
    connectionString: options.connectionString,
    ...(options.maxConnections === undefined ? {} : { max: options.maxConnections }),
  });
  const balanceOf = async (
    q: Pick<Pool, 'query'>,
    tenantId: string,
    currency: string,
  ): Promise<number> => {
    const { rows } = await q.query<{ bal: string | null }>(
      `SELECT COALESCE(SUM(amount_minor), 0) AS bal FROM tf_credits
       WHERE tenant_id = $1 AND currency = $2`,
      [tenantId, currency.toLowerCase()],
    );
    return Math.max(0, Number(rows[0]?.bal ?? 0));
  };

  return {
    async grant(grant: CreditGrant): Promise<void> {
      await pool.query(
        `INSERT INTO tf_credits (tenant_id, amount_minor, currency, reason, reference)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          grant.tenantId,
          grant.amountMinor,
          grant.currency.toLowerCase(),
          grant.reason,
          grant.reference ?? null,
        ],
      );
    },

    async consume(request: CreditConsume): Promise<{ consumedMinor: number }> {
      const currency = request.currency.toLowerCase();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Serialize consumes for this tenant so two concurrent charges can't both spend the balance.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [request.tenantId]);
        // Idempotent: if this reference was already consumed, return that amount unchanged.
        const existing = await client.query<{ amount_minor: string }>(
          `SELECT amount_minor FROM tf_credits
           WHERE tenant_id = $1 AND currency = $2 AND reference = $3 AND amount_minor < 0`,
          [request.tenantId, currency, request.reference],
        );
        if ((existing.rowCount ?? 0) > 0) {
          await client.query('COMMIT');
          return { consumedMinor: -Number(existing.rows[0]!.amount_minor) };
        }
        const balance = await balanceOf(client, request.tenantId, currency);
        const consumedMinor = Math.max(0, Math.min(balance, request.amountMinor));
        if (consumedMinor > 0) {
          await client.query(
            `INSERT INTO tf_credits (tenant_id, amount_minor, currency, reason, reference)
             VALUES ($1, $2, $3, $4, $5)`,
            [request.tenantId, -consumedMinor, currency, request.reason, request.reference],
          );
        }
        await client.query('COMMIT');
        return { consumedMinor };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    balance(tenantId: string, currency: string): Promise<number> {
      return balanceOf(pool, tenantId, currency);
    },

    async history(tenantId: string, limit: number): Promise<CreditEntry[]> {
      const { rows } = await pool.query<Row>(
        `SELECT amount_minor, currency, reason, reference, created_at FROM tf_credits
         WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
        [tenantId, limit],
      );
      return rows.map((r) => ({
        tenantId,
        amountMinor: Number(r.amount_minor),
        currency: r.currency,
        reason: r.reason,
        ...(r.reference !== null ? { reference: r.reference } : {}),
        at: r.created_at.toISOString(),
      }));
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
