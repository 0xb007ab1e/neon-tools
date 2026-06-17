import { z } from 'zod';
import type {
  ProvisioningProvider,
  ProvisionRequest,
  ProvisionResult,
} from '../../ports/provisioning-provider.js';

/** Shape of the Neon "create project" response we depend on. */
const CreateProjectResponseSchema = z.object({
  project: z.object({ id: z.string().min(1) }),
  connection_uris: z
    .array(z.object({ connection_uri: z.string().min(1) }))
    .min(1, 'Neon API returned no connection URI for the project'),
});

/** Configuration for the Neon API provisioning provider. */
export interface NeonProvisioningOptions {
  /** Neon API key (bearer token) — a secret read from config. */
  apiKey: string;
  /** Neon organization id; required because the account is org-scoped. */
  orgId: string;
  /** API base URL (defaults to the public Neon API). */
  baseUrl?: string;
  /** Per-request timeout in ms. Defaults to 30000. */
  timeoutMs?: number;
  /** Max attempts for transient failures (network/5xx). Defaults to 3. */
  maxAttempts?: number;
  /** Injectable fetch (for testing). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/** A transient (retryable) Neon API failure. */
class TransientNeonError extends Error {}

/**
 * Create a {@link ProvisioningProvider} backed by the Neon API (project-per-tenant).
 *
 * The Neon API is an **untrusted upstream**: every call has a timeout, transient failures are
 * retried with bounded exponential backoff, and responses are schema-validated before use
 * (topic-api-consumption). The API key is a secret and is never logged.
 *
 * @param options - API key, org id, and optional base URL / timeout / retry / fetch.
 * @returns A provisioning provider.
 */
export function createNeonProvisioningProvider(
  options: NeonProvisioningOptions,
): ProvisioningProvider {
  const baseUrl = (options.baseUrl ?? 'https://console.neon.tech/api/v2').replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const doFetch = options.fetchImpl ?? globalThis.fetch;

  const once = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await doFetch(`${baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
        });
      } catch (cause) {
        // Network error / timeout — retryable.
        throw new TransientNeonError(`Neon API ${method} ${path} request failed`, { cause });
      }
      if (!response.ok) {
        let detail = '';
        try {
          detail = (await response.text()).slice(0, 200);
        } catch {
          detail = '';
        }
        const message = `Neon API ${method} ${path} failed: HTTP ${response.status} ${detail}`;
        // 429 + 5xx are transient; 4xx (except 429) are caller errors — fail fast.
        if (response.status === 429 || response.status >= 500) {
          throw new TransientNeonError(message);
        }
        throw new Error(message);
      }
      if (response.status === 204) return undefined;
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  };

  const api = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await once(method, path, body);
      } catch (error) {
        lastError = error;
        if (!(error instanceof TransientNeonError) || attempt === maxAttempts) throw error;
        // Exponential backoff with a fixed base; jitter omitted for determinism in tests.
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** (attempt - 1)));
      }
    }
    // Unreachable: the loop either returns or throws. Satisfies the type checker.
    throw lastError instanceof Error ? lastError : new Error('Neon API call failed');
  };

  return {
    async createTenantProject(request: ProvisionRequest): Promise<ProvisionResult> {
      const json = await api('POST', '/projects', {
        project: {
          name: `tenant-${request.slug}`,
          region_id: request.region,
          org_id: options.orgId,
        },
      });
      const parsed = CreateProjectResponseSchema.parse(json);
      return {
        neonProjectId: parsed.project.id,
        connectionUri: parsed.connection_uris[0]!.connection_uri,
      };
    },

    async deleteTenantProject(neonProjectId: string): Promise<void> {
      await api('DELETE', `/projects/${encodeURIComponent(neonProjectId)}`);
    },
  };
}
