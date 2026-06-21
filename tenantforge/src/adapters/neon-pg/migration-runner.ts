import { Pool } from 'pg';
import type { MigrationExecution, MigrationRunner } from '../../ports/migration-runner.js';
import { assertPostgresTls } from '../../core/transport-security.js';

/** Options for {@link createPgMigrationRunner}. */
export interface PgMigrationRunnerOptions {
  /** Per-tenant connection timeout in ms. Defaults to 30000. */
  connectionTimeoutMs?: number;
  /** Statement timeout in ms applied to the migration session. Defaults to 60000. */
  statementTimeoutMs?: number;
  /** Permit a non-TLS per-tenant connection (local dev only — documented leaky-endpoint opt-out). */
  allowInsecure?: boolean;
}

/**
 * Create a {@link MigrationRunner} that applies a migration to one tenant database over a transient
 * `pg` connection.
 *
 * The migration runs inside a transaction with a bounded statement timeout, so a failure rolls back
 * cleanly and one tenant's hang can't stall the fleet. The connection URI is a secret (resolved
 * server-side via the connection router) and is never logged. The migration SQL itself must be
 * idempotent + backward-compatible (expand/contract) — that is the author's responsibility.
 *
 * @param options - Optional connection / statement timeouts.
 * @returns A migration runner.
 */
export function createPgMigrationRunner(options: PgMigrationRunnerOptions = {}): MigrationRunner {
  const connectionTimeoutMillis = options.connectionTimeoutMs ?? 30_000;
  const statementTimeoutMs = options.statementTimeoutMs ?? 60_000;

  return {
    async applyToTenant(connectionUri: string, migration: MigrationExecution): Promise<void> {
      // The per-tenant URI is resolved server-side from the secret store; verify it negotiates TLS
      // before opening the connection (a tenant DB carries customer data — never plaintext).
      assertPostgresTls(connectionUri, 'tenant connection URI', options.allowInsecure);
      // One transient pool per tenant application; the orchestrator bounds overall concurrency.
      const pool = new Pool({ connectionString: connectionUri, max: 1, connectionTimeoutMillis });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);
        await client.query(migration.sql);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error instanceof Error
          ? new Error(`migration ${migration.version} failed: ${error.message}`)
          : error;
      } finally {
        client.release();
        await pool.end();
      }
    },
  };
}
