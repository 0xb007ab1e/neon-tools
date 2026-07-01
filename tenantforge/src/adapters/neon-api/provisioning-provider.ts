import { z } from 'zod';
import type {
  ProvisioningProvider,
  ProvisionRequest,
  ProvisionResult,
} from '../../ports/provisioning-provider.js';
import { assertHttpsUrl } from '../../core/transport-security.js';
import type { EventSink } from '../../ports/event-sink.js';
import { createNoopEventSink } from '../event-sink.js';

/** Shape of the Neon "create project" response we depend on. */
const CreateProjectResponseSchema = z.object({
  project: z.object({ id: z.string().min(1) }),
  connection_uris: z
    .array(z.object({ connection_uri: z.string().min(1) }))
    .min(1, 'Neon API returned no connection URI for the project'),
});

/** Project branches (we need the default branch to locate the owner role for rotation). */
const BranchesResponseSchema = z.object({
  branches: z
    .array(z.object({ id: z.string().min(1), default: z.boolean().optional() }))
    .min(1, 'Neon API returned no branches for the project'),
});

/** Roles on a branch (we rotate the first role — the project owner). */
const RolesResponseSchema = z.object({
  roles: z
    .array(z.object({ name: z.string().min(1) }))
    .min(1, 'Neon API returned no roles for the branch'),
});

/** Reset-password response: a fresh connection URI for the rotated role. */
const ResetPasswordResponseSchema = z.object({
  connection_uris: z
    .array(z.object({ connection_uri: z.string().min(1) }))
    .min(1, 'Neon API returned no connection URI for the rotated role'),
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
  /**
   * Supplies trace-propagation headers (e.g. W3C `traceparent`) for each outbound call, so the
   * upstream sees this operation's distributed-trace context. Injected (not read from a global) to
   * keep the adapter decoupled from the request context. Returns `{}` outside any trace scope.
   */
  traceHeaders?: () => Record<string, string>;
  /** Permit a non-https base URL (local dev / mock only — the documented leaky-endpoint opt-out). */
  allowInsecure?: boolean;
  /**
   * Injectable delay between retry attempts (for tests — pass an instant/no-op sleep to keep the
   * retry suite fast + deterministic). Defaults to a real `setTimeout`-backed sleep. The backoff
   * duration itself (exponential + jitter) is computed by the provider; this only performs the wait.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Sink for the Neon upstream-dependency SLI (M2). One `neon.api` {@link TenantEvent} is emitted per
   * logical call (across retries), so `tenantforge_events_total{event="neon.api",outcome}` (error
   * rate) and `tenantforge_event_duration_ms{event="neon.api"}` (latency) render for free from the
   * metrics sink. Defaults to a no-op. Context carries a **bounded** `operation` label (never a raw
   * id-bearing path) and never a secret.
   */
  eventSink?: EventSink;
}

/**
 * A Neon API failure carrying the observed HTTP status (0 = network error / timeout) and whether it
 * is transient (retryable). Used to attribute the {@link EventSink} `neon.api` event's context.
 */
class NeonApiError extends Error {
  /** Last observed HTTP status, or 0 for a network error / timeout. */
  readonly status: number;
  /** Whether the failure is transient (429 / 5xx / network) and thus retryable. */
  readonly transient: boolean;

  constructor(message: string, opts: { status: number; transient: boolean; cause?: unknown }) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.status = opts.status;
    this.transient = opts.transient;
  }
}

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
  assertHttpsUrl(baseUrl, 'NEON_API_BASE_URL', options.allowInsecure);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const traceHeaders = options.traceHeaders ?? (() => ({}));
  const eventSink = options.eventSink ?? createNoopEventSink();
  const sleep =
    options.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));

  /** The parsed body plus the observed HTTP status, so `api()` can attribute the SLI event. */
  interface OnceResult {
    body: unknown;
    status: number;
  }

  const once = async (method: string, path: string, body?: unknown): Promise<OnceResult> => {
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
            // Distributed-trace propagation (W3C). Listed after the fixed headers; the provider
            // only ever returns safe propagation headers, never overriding auth/content-type.
            ...traceHeaders(),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
        });
      } catch (cause) {
        // Network error / timeout — retryable. status 0 marks "no HTTP response".
        throw new NeonApiError(`Neon API ${method} ${path} request failed`, {
          status: 0,
          transient: true,
          cause,
        });
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
        const transient = response.status === 429 || response.status >= 500;
        throw new NeonApiError(message, { status: response.status, transient });
      }
      if (response.status === 204) return { body: undefined, status: response.status };
      return { body: await response.json(), status: response.status };
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * Invoke the Neon API with bounded retries, emitting exactly ONE `neon.api` SLI event per logical
   * call (across all retry attempts). `operation` is a bounded label (never the raw id-bearing path).
   *
   * @param operation - A bounded operation label for the metrics `operation` context (low cardinality).
   * @param method - HTTP method.
   * @param path - Request path (may contain ids — used only for the request/error message, not a label).
   * @param body - Optional JSON request body.
   * @returns The parsed response body.
   */
  const api = async (
    operation: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> => {
    const startedAt = Date.now();
    let attempts = 0;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts = attempt;
      try {
        const result = await once(method, path, body);
        eventSink.emit({
          event: 'neon.api',
          at: new Date().toISOString(),
          outcome: 'ok',
          durationMs: Date.now() - startedAt,
          context: { operation, status: result.status, attempts, transient: false },
        });
        return result.body;
      } catch (error) {
        lastError = error;
        const isTransient = error instanceof NeonApiError && error.transient;
        if (!isTransient || attempt === maxAttempts) {
          const status = error instanceof NeonApiError ? error.status : 0;
          eventSink.emit({
            event: 'neon.api',
            at: new Date().toISOString(),
            outcome: 'error',
            durationMs: Date.now() - startedAt,
            context: { operation, status, attempts, transient: isTransient },
          });
          throw error;
        }
        // Exponential backoff with **full jitter** (topic-reliability / topic-api-consumption): sleep a
        // random duration in [0, min(cap, base·2^(attempt-1))] to avoid a synchronized retry storm
        // across the fleet during a Neon outage. Math.random is fine here (jitter, not a security
        // context). Tests inject an instant `sleep` for determinism/speed.
        const backoffCeil = Math.min(2000, 100 * 2 ** (attempt - 1));
        await sleep(Math.floor(Math.random() * backoffCeil));
      }
    }
    // Unreachable: the loop either returns or throws. Satisfies the type checker.
    throw lastError instanceof Error ? lastError : new Error('Neon API call failed');
  };

  return {
    async createTenantProject(request: ProvisionRequest): Promise<ProvisionResult> {
      const json = await api('create_project', 'POST', '/projects', {
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
      await api('delete_project', 'DELETE', `/projects/${encodeURIComponent(neonProjectId)}`);
    },

    async rotateTenantCredential(neonProjectId: string): Promise<{ connectionUri: string }> {
      // Reset the owner role's password on the project's default branch → a fresh connection URI.
      // (Integration-verified via the live game-day, like the other Neon API calls.)
      const projectPath = `/projects/${encodeURIComponent(neonProjectId)}`;
      const branches = BranchesResponseSchema.parse(
        await api('list_branches', 'GET', `${projectPath}/branches`),
      );
      const branch = branches.branches.find((b) => b.default === true) ?? branches.branches[0]!;
      const branchPath = `${projectPath}/branches/${encodeURIComponent(branch.id)}`;
      const roles = RolesResponseSchema.parse(
        await api('list_roles', 'GET', `${branchPath}/roles`),
      );
      const roleName = roles.roles[0]!.name;
      const reset = ResetPasswordResponseSchema.parse(
        await api(
          'reset_role_password',
          'POST',
          `${branchPath}/roles/${encodeURIComponent(roleName)}/reset_password`,
        ),
      );
      return { connectionUri: reset.connection_uris[0]!.connection_uri };
    },
  };
}
