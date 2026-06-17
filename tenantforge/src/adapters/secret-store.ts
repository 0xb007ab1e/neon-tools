import type { SecretStore } from '../ports/secret-store.js';

/**
 * Create an in-memory {@link SecretStore}.
 *
 * For tests and local development only — secrets live in process memory and are lost on restart.
 * **Production must inject a persistent secret manager** (Vault / cloud Secrets Manager) at the
 * composition root; this adapter exists so the connection-secret flow is exercisable without that
 * infrastructure (the port keeps it pluggable).
 *
 * @returns An in-memory secret store.
 */
export function createInMemorySecretStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    set(key: string, value: string): Promise<void> {
      map.set(key, value);
      return Promise.resolve();
    },
    get(key: string): Promise<string | null> {
      return Promise.resolve(map.get(key) ?? null);
    },
    delete(key: string): Promise<void> {
      map.delete(key);
      return Promise.resolve();
    },
  };
}
