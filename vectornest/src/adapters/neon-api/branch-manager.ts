import { z } from 'zod';
import type { BranchManager } from '../../ports/branch-manager.js';

/** Shape of the Neon "create branch" response we depend on. */
const CreateBranchResponseSchema = z.object({
  branch: z.object({ id: z.string() }),
  connection_uris: z
    .array(z.object({ connection_uri: z.string().min(1) }))
    .min(1, 'Neon API returned no connection URI for the branch'),
});

/** Configuration for the Neon API branch manager. */
export interface NeonApiOptions {
  /** Neon API key (bearer token). */
  apiKey: string;
  /** Neon project id the branches live under. */
  projectId: string;
  /** API base URL (defaults to the public Neon API). */
  baseUrl?: string;
  /** Per-request timeout in ms. Defaults to 30000. */
  timeoutMs?: number;
  /** Injectable fetch (for testing). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Create a {@link BranchManager} backed by the Neon API.
 *
 * Used for re-embed rehearsal: create a cheap copy-on-write branch, validate a model swap on it,
 * then delete it — production is never touched. The API key is a secret read from config.
 *
 * @param options - API key, project id, and optional base URL / timeout / fetch.
 * @returns A branch manager.
 */
export function createNeonBranchManager(options: NeonApiOptions): BranchManager {
  const baseUrl = (options.baseUrl ?? 'https://console.neon.tech/api/v2').replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 30_000;
  const doFetch = options.fetchImpl ?? globalThis.fetch;

  const api = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      if (!response.ok) {
        let detail = '';
        try {
          detail = (await response.text()).slice(0, 200);
        } catch {
          detail = '';
        }
        throw new Error(`Neon API ${method} ${path} failed: HTTP ${response.status} ${detail}`);
      }
      if (response.status === 204) return undefined;
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async createBranch(name: string): Promise<{ branchId: string; connectionUri: string }> {
      const json = await api('POST', `/projects/${options.projectId}/branches`, {
        branch: { name },
        endpoints: [{ type: 'read_write' }],
      });
      const parsed = CreateBranchResponseSchema.parse(json);
      return {
        branchId: parsed.branch.id,
        connectionUri: parsed.connection_uris[0]!.connection_uri,
      };
    },

    async deleteBranch(branchId: string): Promise<void> {
      await api('DELETE', `/projects/${options.projectId}/branches/${branchId}`);
    },
  };
}
