import { z } from 'zod';
import type { SecretStore } from '../../ports/secret-store.js';
import { assertHttpsUrl } from '../../core/transport-security.js';

/** Shape of the Vault KV v2 read response we depend on (`GET .../data/{path}`). */
const ReadResponseSchema = z.object({
  // `data.data` holds the stored key/value map; it is null for a soft-deleted version.
  data: z
    .object({
      data: z.object({ value: z.string() }).nullable(),
    })
    .nullable(),
});

/** Options for {@link createVaultSecretStore}. */
export interface VaultSecretStoreOptions {
  /** Vault server base URL, e.g. `https://vault.example.com:8200`. Use TLS (`https`). */
  address: string;
  /** Vault token (a secret) — never logged. */
  token: string;
  /** KV v2 secrets-engine mount path. Defaults to `secret`. */
  mountPath?: string;
  /** Path prefix under the mount; each tenant lands at `{prefix}/{key}`. Defaults to `tenantforge`. */
  pathPrefix?: string;
  /** Vault Enterprise namespace (`X-Vault-Namespace`), if any. */
  namespace?: string;
  /** Per-request timeout in ms. Defaults to 30000. */
  timeoutMs?: number;
  /** Injectable fetch (for testing). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Permit a non-https Vault address (local dev only — the documented leaky-endpoint opt-out). */
  allowInsecure?: boolean;
}

/**
 * Create a {@link SecretStore} backed by **HashiCorp Vault** (KV v2) over its HTTP API.
 *
 * Per-tenant connection secrets are stored at `{mount}/data/{prefix}/{tenantId}` as `{ value }`.
 * `delete` removes **all versions + metadata** (`DELETE .../metadata/{path}`) so offboarding truly
 * crypto-shreds the secret (workflow-data-lifecycle), not a soft-delete. Vault is an **untrusted
 * upstream** (topic-api-consumption): every call has a timeout and a schema-validated response, and
 * the token + secret values are never logged.
 *
 * This is a non-Neon backend for the SecretStore port, in its own branch per the project's
 * "Neon-first, others later" rule. Cloud secret managers (AWS/GCP/Azure) can follow the same shape.
 *
 * @param options - Vault address + token and optional mount / prefix / namespace / timeout / fetch.
 * @returns A Vault-backed secret store.
 */
export function createVaultSecretStore(options: VaultSecretStoreOptions): SecretStore {
  // Vault carries per-tenant connection secrets — refuse a plaintext address (master §5).
  assertHttpsUrl(options.address, 'VAULT_ADDR', options.allowInsecure);
  const address = options.address.replace(/\/+$/, '');
  const mount = (options.mountPath ?? 'secret').replace(/^\/+|\/+$/g, '');
  const prefix = (options.pathPrefix ?? 'tenantforge').replace(/^\/+|\/+$/g, '');
  const timeoutMs = options.timeoutMs ?? 30_000;
  const doFetch = options.fetchImpl ?? globalThis.fetch;

  const headers = (): Record<string, string> => {
    const h: Record<string, string> = {
      'x-vault-token': options.token,
      accept: 'application/json',
    };
    if (options.namespace !== undefined && options.namespace !== '') {
      h['x-vault-namespace'] = options.namespace;
    }
    return h;
  };

  // KV v2 splits data (`/data/{path}`) from metadata (`/metadata/{path}`); `kind` selects which.
  const url = (kind: 'data' | 'metadata', key: string): string =>
    `${address}/v1/${mount}/${kind}/${prefix}/${encodeURIComponent(key)}`;

  /** Issue a request with a timeout; returns the response (never throws on non-2xx — caller checks). */
  const request = async (target: string, init: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(target, { ...init, headers: headers(), signal: controller.signal });
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
      const response = await request(url('data', key), {
        method: 'POST',
        body: JSON.stringify({ data: { value } }),
      });
      if (!response.ok) {
        throw new Error(`Vault write failed: HTTP ${response.status} ${await detail(response)}`);
      }
    },

    async get(key: string): Promise<string | null> {
      const response = await request(url('data', key), { method: 'GET' });
      if (response.status === 404) return null; // absent
      if (!response.ok) {
        throw new Error(`Vault read failed: HTTP ${response.status} ${await detail(response)}`);
      }
      const parsed = ReadResponseSchema.parse(await response.json());
      return parsed.data?.data?.value ?? null; // soft-deleted version → data.data is null
    },

    async delete(key: string): Promise<void> {
      // Permanently remove all versions + metadata (crypto-shred). 404 ⇒ already gone (idempotent).
      const response = await request(url('metadata', key), { method: 'DELETE' });
      if (!response.ok && response.status !== 404) {
        throw new Error(`Vault delete failed: HTTP ${response.status} ${await detail(response)}`);
      }
    },
  };
}
