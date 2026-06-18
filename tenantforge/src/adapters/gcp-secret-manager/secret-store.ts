import type { SecretStore } from '../../ports/secret-store.js';

// --- A minimal GCP Secret Manager client surface (the calls this adapter uses) -----------------
// Zero-dependency by design: the `@google-cloud/secret-manager` `SecretManagerServiceClient`
// satisfies this via a tiny shim (its methods return gax `[response]` tuples — unwrap the first
// element). Wire it at the composition root, e.g.:
//   const smc = new SecretManagerServiceClient();
//   const client: GcpSecretManagerClientLike = {
//     createSecret: (i) => smc.createSecret({ ...i, secret: { replication: { automatic: {} } } }),
//     addSecretVersion: (i) => smc.addSecretVersion(i),
//     accessSecretVersion: (i) => smc.accessSecretVersion(i).then(([r]) => r),
//     deleteSecret: (i) => smc.deleteSecret(i),
//   };

/** The narrow Secret Manager client this adapter depends on (the GCP SDK client satisfies it). */
export interface GcpSecretManagerClientLike {
  /** `CreateSecret` — create the secret container (replication policy set in the shim). */
  createSecret(input: { parent: string; secretId: string }): Promise<unknown>;
  /** `AddSecretVersion` — add a new version holding the payload bytes. */
  addSecretVersion(input: { parent: string; payload: { data: Buffer } }): Promise<unknown>;
  /** `AccessSecretVersion` — read a version's payload (data is `Buffer` via the SDK). */
  accessSecretVersion(input: {
    name: string;
  }): Promise<{ payload?: { data?: string | Uint8Array | null } | null }>;
  /** `DeleteSecret` — delete the secret and all its versions. */
  deleteSecret(input: { name: string }): Promise<unknown>;
}

/** Options for {@link createGcpSecretManagerStore}. */
export interface GcpSecretManagerStoreOptions {
  /** The narrow Secret Manager client (wrap your `@google-cloud/secret-manager` client). */
  client: GcpSecretManagerClientLike;
  /** GCP project id that owns the secrets. */
  project: string;
  /**
   * Secret-id prefix joined to the key with `-` (GCP secret ids are `[A-Za-z0-9_-]+`, so no `/`).
   * Defaults to `tenantforge` → `tenantforge-{tenantId}`. Empty string uses the bare key.
   */
  prefix?: string;
}

/** gRPC status codes the adapter reacts to (NOT_FOUND, ALREADY_EXISTS). */
const NOT_FOUND = 5;
const ALREADY_EXISTS = 6;

/** True when a GCP/gRPC error carries the given numeric status `code`. */
function hasCode(error: unknown, code: number): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

/**
 * Create a {@link SecretStore} backed by **GCP Secret Manager**, over a minimal injected client (so
 * the Google SDK is not a dependency of this project — wrap your `SecretManagerServiceClient` per the
 * shim above). A non-Neon backend for the SecretStore port, in its own branch per the project's
 * "Neon-first, others later" rule; the same injected-client shape as the SQS / AWS adapters.
 *
 * A tenant's connection secret maps to the secret `{prefix}-{tenantId}`. `set` ensures the secret
 * container exists (`CreateSecret`, tolerating `ALREADY_EXISTS`) then writes a new version
 * (`AddSecretVersion`). `get` accesses the `latest` version and returns null when the secret/version
 * is absent (`NOT_FOUND`). `delete` removes the secret **and all versions** so offboarding truly
 * crypto-shreds it (workflow-data-lifecycle), and is idempotent. Secret values are **never logged**;
 * errors other than the handled status codes propagate unchanged.
 *
 * @param options - The Secret Manager client, GCP project id, and optional id prefix.
 * @returns A GCP Secret Manager-backed secret store.
 */
export function createGcpSecretManagerStore(options: GcpSecretManagerStoreOptions): SecretStore {
  const { client, project } = options;
  const rawPrefix = (options.prefix ?? 'tenantforge').replace(/^-+|-+$/g, '');
  const secretId = (key: string): string => (rawPrefix === '' ? key : `${rawPrefix}-${key}`);
  const secretName = (key: string): string => `projects/${project}/secrets/${secretId(key)}`;

  return {
    async set(key: string, value: string): Promise<void> {
      try {
        await client.createSecret({ parent: `projects/${project}`, secretId: secretId(key) });
      } catch (error) {
        if (!hasCode(error, ALREADY_EXISTS)) throw error; // first write creates; later writes reuse
      }
      await client.addSecretVersion({
        parent: secretName(key),
        payload: { data: Buffer.from(value, 'utf8') },
      });
    },

    async get(key: string): Promise<string | null> {
      try {
        const response = await client.accessSecretVersion({
          name: `${secretName(key)}/versions/latest`,
        });
        const data = response.payload?.data;
        if (data === null || data === undefined) return null;
        // SDK yields a Buffer/Uint8Array; a string (e.g. a REST shim) is passed through as-is.
        return typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
      } catch (error) {
        if (hasCode(error, NOT_FOUND)) return null; // absent
        throw error;
      }
    },

    async delete(key: string): Promise<void> {
      try {
        await client.deleteSecret({ name: secretName(key) });
      } catch (error) {
        if (hasCode(error, NOT_FOUND)) return; // already gone — idempotent
        throw error;
      }
    },
  };
}
