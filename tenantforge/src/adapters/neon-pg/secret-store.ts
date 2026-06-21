import { Pool } from 'pg';
import type { SecretStore } from '../../ports/secret-store.js';
import { open, seal } from '../secret-crypto.js';
import { assertPostgresTls } from '../../core/transport-security.js';

/** Options for {@link createNeonPgSecretStore}. */
export interface NeonPgSecretStoreOptions {
  /** Control-plane Postgres connection string (the `tf_connection_secrets` table lives here). */
  connectionString: string;
  /** The 32-byte AES key (see {@link import('../secret-crypto.js').deriveKey}). */
  key: Buffer;
  /** Max pool size. Defaults to the `pg` default. */
  maxConnections?: number;
  /** Permit a non-TLS connection (local dev only — the documented leaky-endpoint opt-out). */
  allowInsecure?: boolean;
}

/**
 * Create a persistent {@link SecretStore} backed by Neon Postgres, with each value
 * **AES-256-GCM-encrypted at rest** (`tf_connection_secrets`, migration 0002).
 *
 * The encryption key is held separately from this DB's credential (separation of duties — master
 * §5): a compromise of the control-plane database alone yields only ciphertext. This is the
 * Neon-prioritized production adapter; a Vault / cloud Secrets Manager or fetch-from-Neon-API
 * backend can be added later behind the same port, each in its own branch.
 *
 * @param options - Connection string, AES key, and optional pool size.
 * @returns A persistent, encrypted secret store.
 */
export function createNeonPgSecretStore(options: NeonPgSecretStoreOptions): SecretStore {
  const { key } = options;
  // Fail closed if the control-plane connection (holding encrypted secrets) would run plaintext.
  assertPostgresTls(options.connectionString, 'DATABASE_URL', options.allowInsecure);
  const pool = new Pool({
    connectionString: options.connectionString,
    ...(options.maxConnections === undefined ? {} : { max: options.maxConnections }),
  });

  return {
    async set(secretKey: string, value: string): Promise<void> {
      const sealed = seal(key, value);
      await pool.query(
        `INSERT INTO tf_connection_secrets (key, sealed) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET sealed = EXCLUDED.sealed, updated_at = now()`,
        [secretKey, sealed],
      );
    },

    async get(secretKey: string): Promise<string | null> {
      const { rows } = await pool.query<{ sealed: string }>(
        'SELECT sealed FROM tf_connection_secrets WHERE key = $1',
        [secretKey],
      );
      return rows[0] ? open(key, rows[0].sealed) : null;
    },

    async delete(secretKey: string): Promise<void> {
      await pool.query('DELETE FROM tf_connection_secrets WHERE key = $1', [secretKey]);
    },
  };
}
