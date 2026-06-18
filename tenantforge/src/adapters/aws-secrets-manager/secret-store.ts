import type { SecretStore } from '../../ports/secret-store.js';

// --- A minimal AWS Secrets Manager client surface (the calls this adapter uses) ----------------
// Zero-dependency by design: the AWS SDK v3 `SecretsManagerClient` satisfies this via a tiny shim,
// so we don't pull the SDK tree into the project. Wire it at the composition root, e.g.:
//   const sm = new SecretsManagerClient({ region });
//   const client: SecretsManagerClientLike = {
//     getSecretValue: (i) => sm.send(new GetSecretValueCommand(i)),
//     createSecret:   (i) => sm.send(new CreateSecretCommand(i)),
//     putSecretValue: (i) => sm.send(new PutSecretValueCommand(i)),
//     deleteSecret:   (i) => sm.send(new DeleteSecretCommand(i)),
//   };

/** The narrow Secrets Manager client this adapter depends on (the AWS SDK client satisfies it). */
export interface SecretsManagerClientLike {
  /** `GetSecretValue` — read a secret's string value. */
  getSecretValue(input: { SecretId: string }): Promise<{ SecretString?: string }>;
  /** `CreateSecret` — create a new secret (fails if it already exists). */
  createSecret(input: { Name: string; SecretString: string }): Promise<unknown>;
  /** `PutSecretValue` — write a new version of an existing secret (fails if absent). */
  putSecretValue(input: { SecretId: string; SecretString: string }): Promise<unknown>;
  /** `DeleteSecret` — delete a secret; `ForceDeleteWithoutRecovery` skips the recovery window. */
  deleteSecret(input: { SecretId: string; ForceDeleteWithoutRecovery?: boolean }): Promise<unknown>;
}

/** Options for {@link createAwsSecretsManagerStore}. */
export interface AwsSecretsManagerStoreOptions {
  /** The narrow Secrets Manager client (wrap your `@aws-sdk/client-secrets-manager` client). */
  client: SecretsManagerClientLike;
  /** Name prefix; each tenant lands at `{prefix}/{key}`. Defaults to `tenantforge`. */
  prefix?: string;
}

/** True when an AWS SDK error denotes a missing secret (`ResourceNotFoundException`). */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'ResourceNotFoundException'
  );
}

/**
 * Create a {@link SecretStore} backed by **AWS Secrets Manager**, over a minimal injected client (so
 * the AWS SDK is not a dependency of this project — wrap your `SecretsManagerClient` per the shim
 * above). A non-Neon backend for the SecretStore port, in its own branch per the project's
 * "Neon-first, others later" rule; the same shape as the SQS message-queue adapter.
 *
 * Per-tenant connection secrets are stored under `{prefix}/{tenantId}` as the secret string. `set`
 * writes a new version (`PutSecretValue`) and creates the secret on first use (`CreateSecret` when
 * the version write reports the secret is absent). `delete` uses **`ForceDeleteWithoutRecovery`** so
 * offboarding truly crypto-shreds the secret (workflow-data-lifecycle), not a recoverable soft-delete,
 * and is idempotent (a missing secret is a no-op). Secret values are **never logged**; AWS SDK errors
 * other than not-found propagate unchanged.
 *
 * @param options - The Secrets Manager client and optional name prefix.
 * @returns An AWS Secrets Manager-backed secret store.
 */
export function createAwsSecretsManagerStore(options: AwsSecretsManagerStoreOptions): SecretStore {
  const { client } = options;
  const prefix = (options.prefix ?? 'tenantforge').replace(/^\/+|\/+$/g, '');
  const name = (key: string): string => `${prefix}/${key}`;

  return {
    async set(key: string, value: string): Promise<void> {
      const SecretId = name(key);
      try {
        await client.putSecretValue({ SecretId, SecretString: value });
      } catch (error) {
        if (isNotFound(error)) {
          // First write for this tenant — the secret doesn't exist yet, so create it.
          await client.createSecret({ Name: SecretId, SecretString: value });
        } else {
          throw error;
        }
      }
    },

    async get(key: string): Promise<string | null> {
      try {
        const { SecretString } = await client.getSecretValue({ SecretId: name(key) });
        return SecretString ?? null; // a binary-only secret has no SecretString
      } catch (error) {
        if (isNotFound(error)) return null; // absent
        throw error;
      }
    },

    async delete(key: string): Promise<void> {
      try {
        await client.deleteSecret({ SecretId: name(key), ForceDeleteWithoutRecovery: true });
      } catch (error) {
        if (isNotFound(error)) return; // already gone — idempotent
        throw error;
      }
    },
  };
}
