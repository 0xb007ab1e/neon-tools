/**
 * Port: a dedicated store for per-tenant connection secrets.
 *
 * Connection URIs are **secrets** and must NOT live in the control-plane registry (master §5,
 * workflow-secrets). The control plane keys each secret by tenant id; the production adapter is a
 * vault / cloud secret manager (a path like `tenants/{id}/connection`). Offboarding deletes the
 * key (crypto-shred — workflow-data-lifecycle). Implementations never log secret values.
 */
export interface SecretStore {
  /**
   * Store (or overwrite) a secret under a key.
   *
   * @param key - The opaque key (the tenant id).
   * @param value - The secret value (a connection URI).
   */
  set(key: string, value: string): Promise<void>;

  /**
   * Retrieve a secret by key.
   *
   * @param key - The key (the tenant id).
   * @returns The secret value, or null if absent.
   */
  get(key: string): Promise<string | null>;

  /**
   * Delete a secret (irreversible — used on offboard to crypto-shred).
   *
   * @param key - The key (the tenant id).
   */
  delete(key: string): Promise<void>;
}
