import { z } from 'zod';
import type { ProjectSnapshot, SnapshotProvider } from '../../ports/snapshot-provider.js';
import { assertHttpsUrl } from '../../core/transport-security.js';

/** Prefix marking branches that are TenantForge snapshots (vs. the project's own branches). */
const SNAPSHOT_PREFIX = 'snapshot-';

/** A Neon branch as returned by the API (the fields we depend on). */
const BranchSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(''),
  default: z.boolean().optional(),
  created_at: z.string().min(1),
});
const CreateBranchResponseSchema = z.object({ branch: BranchSchema });
const ListBranchesResponseSchema = z.object({ branches: z.array(BranchSchema) });

/** Configuration for the Neon API snapshot provider. */
export interface NeonSnapshotOptions {
  /** Neon API key (bearer token) — a secret read from config. */
  apiKey: string;
  /** API base URL (defaults to the public Neon API). */
  baseUrl?: string;
  /** Per-request timeout in ms. Defaults to 30000. */
  timeoutMs?: number;
  /** Max attempts for transient failures (network/5xx). Defaults to 3. */
  maxAttempts?: number;
  /** Injectable fetch (for testing). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Permit a non-https base URL (local dev / mock only — the documented leaky-endpoint opt-out). */
  allowInsecure?: boolean;
}

/** A transient (retryable) Neon API failure. */
class TransientNeonError extends Error {}

function toSnapshot(branch: z.infer<typeof BranchSchema>): ProjectSnapshot {
  return { id: branch.id, name: branch.name, createdAt: new Date(branch.created_at) };
}

/**
 * Create a {@link SnapshotProvider} backed by the Neon API, realizing snapshots as **branches**
 * (copy-on-write — instant, cheap restore points). The Neon API is an untrusted upstream: every
 * call has a timeout, transient failures retry with bounded backoff, and responses are
 * schema-validated (topic-api-consumption). The API key is a secret and is never logged.
 *
 * @param options - API key and optional base URL / timeout / retry / fetch.
 * @returns A Neon-branch-backed snapshot provider.
 */
export function createNeonSnapshotProvider(options: NeonSnapshotOptions): SnapshotProvider {
  const baseUrl = (options.baseUrl ?? 'https://console.neon.tech/api/v2').replace(/\/+$/, '');
  assertHttpsUrl(baseUrl, 'NEON_API_BASE_URL', options.allowInsecure);
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
        if (response.status === 429 || response.status >= 500)
          throw new TransientNeonError(message);
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
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** (attempt - 1)));
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Neon API call failed');
  };

  const projectPath = (id: string): string => `/projects/${encodeURIComponent(id)}`;

  const defaultBranchId = async (neonProjectId: string): Promise<string> => {
    const { branches } = ListBranchesResponseSchema.parse(
      await api('GET', `${projectPath(neonProjectId)}/branches`),
    );
    const def = branches.find((b) => b.default === true) ?? branches[0];
    if (def === undefined) throw new Error(`Neon project ${neonProjectId} has no branches`);
    return def.id;
  };

  return {
    async createSnapshot(neonProjectId: string, name: string): Promise<ProjectSnapshot> {
      // Branch with no explicit parent_lsn/timestamp captures the default branch's current head.
      const json = await api('POST', `${projectPath(neonProjectId)}/branches`, {
        branch: { name },
      });
      return toSnapshot(CreateBranchResponseSchema.parse(json).branch);
    },

    async listSnapshots(neonProjectId: string): Promise<ProjectSnapshot[]> {
      const { branches } = ListBranchesResponseSchema.parse(
        await api('GET', `${projectPath(neonProjectId)}/branches`),
      );
      return branches
        .filter((b) => b.default !== true && b.name.startsWith(SNAPSHOT_PREFIX))
        .map(toSnapshot);
    },

    async deleteSnapshot(neonProjectId: string, snapshotId: string): Promise<void> {
      await api(
        'DELETE',
        `${projectPath(neonProjectId)}/branches/${encodeURIComponent(snapshotId)}`,
      );
    },

    async restoreSnapshot(neonProjectId: string, snapshotId: string): Promise<void> {
      // Reset the project's default branch to the snapshot branch's state (destructive recovery).
      const target = await defaultBranchId(neonProjectId);
      await api(
        'POST',
        `${projectPath(neonProjectId)}/branches/${encodeURIComponent(target)}/restore`,
        { source_branch_id: snapshotId },
      );
    },
  };
}
