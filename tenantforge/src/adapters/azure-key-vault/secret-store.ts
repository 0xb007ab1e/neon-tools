import { z } from 'zod';
import type { SecretStore } from '../../ports/secret-store.js';
import { assertHttpsUrl } from '../../core/transport-security.js';

/** Shape of the Key Vault secret bundle we depend on (`GET .../secrets/{name}`). */
const SecretBundleSchema = z.object({ value: z.string() });

/** Options for {@link createAzureKeyVaultStore}. */
export interface AzureKeyVaultStoreOptions {
  /** Vault base URL, e.g. `https://my-vault.vault.azure.net`. Use TLS. */
  vaultUrl: string;
  /**
   * Acquire an AAD bearer token for `https://vault.azure.net/.default`. Inject from a credential at
   * the composition root, e.g. `() => cred.getToken('https://vault.azure.net/.default').then(t => t.token)`
   * with `@azure/identity` `DefaultAzureCredential`. The token is a secret — never logged.
   */
  getToken: () => Promise<string>;
  /**
   * Secret-name prefix joined to the key with `-` (Key Vault names are `[0-9a-zA-Z-]+`, so no `/`).
   * Defaults to `tenantforge` → `tenantforge-{tenantId}`. Empty string uses the bare key.
   */
  prefix?: string;
  /** Key Vault REST API version. Defaults to `7.4`. */
  apiVersion?: string;
  /** Per-request timeout in ms. Defaults to 30000. */
  timeoutMs?: number;
  /** Injectable fetch (for testing). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Permit a non-https vault URL (local dev only — the documented leaky-endpoint opt-out). */
  allowInsecure?: boolean;
}

/**
 * Create a {@link SecretStore} backed by **Azure Key Vault** (Secrets) over its REST API.
 *
 * A non-Neon backend for the SecretStore port, in its own branch per the project's "Neon-first,
 * others later" rule; the REST shape of the Vault adapter (not the SDK-shim shape of the AWS/GCP
 * adapters) — Key Vault speaks a clean bearer-token REST API. Per-tenant secrets live at
 * `{vault}/secrets/{prefix}-{tenantId}`; `set` PUTs a new version, `get` reads the current value
 * (null on 404). `delete` soft-deletes **then best-effort purges** the secret so offboarding truly
 * crypto-shreds it (workflow-data-lifecycle); when the vault has purge-protection enabled the purge
 * is refused (403) and the secret is retained per policy until its retention expires — both delete
 * and purge are idempotent (404 tolerated). Key Vault is an **untrusted upstream**
 * (topic-api-consumption): every call has a timeout and a schema-validated read; the token + secret
 * values are never logged.
 *
 * @param options - Vault URL + token provider and optional prefix / api-version / timeout / fetch.
 * @returns An Azure Key Vault-backed secret store.
 */
export function createAzureKeyVaultStore(options: AzureKeyVaultStoreOptions): SecretStore {
  // Key Vault carries per-tenant connection secrets — refuse a plaintext URL (master §5).
  assertHttpsUrl(options.vaultUrl, 'Azure Key Vault URL', options.allowInsecure);
  const vaultUrl = options.vaultUrl.replace(/\/+$/, '');
  const apiVersion = options.apiVersion ?? '7.4';
  const rawPrefix = (options.prefix ?? 'tenantforge').replace(/^-+|-+$/g, '');
  const timeoutMs = options.timeoutMs ?? 30_000;
  const doFetch = options.fetchImpl ?? globalThis.fetch;

  const secretName = (key: string): string => (rawPrefix === '' ? key : `${rawPrefix}-${key}`);
  const secretUrl = (key: string): string =>
    `${vaultUrl}/secrets/${encodeURIComponent(secretName(key))}?api-version=${apiVersion}`;
  const deletedUrl = (key: string): string =>
    `${vaultUrl}/deletedsecrets/${encodeURIComponent(secretName(key))}?api-version=${apiVersion}`;

  /** Issue a request with a bearer token + timeout; returns the response (never throws on non-2xx). */
  const request = async (method: string, target: string, body?: unknown): Promise<Response> => {
    const token = await options.getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(target, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  /** Read a short, secret-free error detail from a failed response body. */
  const detail = async (response: Response): Promise<string> => {
    try {
      return (await response.text()).slice(0, 200);
    } catch {
      return '';
    }
  };

  return {
    async set(key: string, value: string): Promise<void> {
      const response = await request('PUT', secretUrl(key), { value });
      if (!response.ok) {
        throw new Error(
          `Key Vault write failed: HTTP ${response.status} ${await detail(response)}`,
        );
      }
    },

    async get(key: string): Promise<string | null> {
      const response = await request('GET', secretUrl(key));
      if (response.status === 404) return null; // absent
      if (!response.ok) {
        throw new Error(`Key Vault read failed: HTTP ${response.status} ${await detail(response)}`);
      }
      return SecretBundleSchema.parse(await response.json()).value;
    },

    async delete(key: string): Promise<void> {
      // Soft-delete (404 ⇒ already gone — idempotent).
      const deleted = await request('DELETE', secretUrl(key));
      if (!deleted.ok && deleted.status !== 404) {
        throw new Error(`Key Vault delete failed: HTTP ${deleted.status} ${await detail(deleted)}`);
      }
      // Best-effort purge → true crypto-shred. 403 ⇒ purge-protection on (retained per policy);
      // 404 ⇒ not yet visible / already purged; 409 ⇒ purge in progress. Anything else is an error.
      const purged = await request('DELETE', deletedUrl(key));
      if (!purged.ok && ![403, 404, 409].includes(purged.status)) {
        throw new Error(`Key Vault purge failed: HTTP ${purged.status} ${await detail(purged)}`);
      }
    },
  };
}
