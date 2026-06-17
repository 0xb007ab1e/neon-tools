import { z } from 'zod';
import type { BillingPeriod, Consumption } from '../../core/usage.js';
import type { UsageProvider } from '../../ports/usage-provider.js';

/** Shape of the Neon "consumption history per project" response we depend on. */
const ConsumptionResponseSchema = z.object({
  projects: z.array(
    z.object({
      periods: z.array(
        z.object({
          consumption: z.array(
            z.object({
              compute_time_seconds: z.number().nonnegative().default(0),
              active_time_seconds: z.number().nonnegative().default(0),
              written_data_bytes: z.number().nonnegative().default(0),
              synthetic_storage_size_bytes: z.number().nonnegative().default(0),
            }),
          ),
        }),
      ),
    }),
  ),
});

/** Configuration for the Neon usage provider. */
export interface NeonUsageOptions {
  /** Neon API key (bearer token) — a secret read from config. */
  apiKey: string;
  /** Neon organization id (the consumption endpoint is org-scoped). */
  orgId: string;
  /** Bucket granularity. Defaults to `daily`. */
  granularity?: 'hourly' | 'daily' | 'monthly';
  /** API base URL (defaults to the public Neon API). */
  baseUrl?: string;
  /** Per-request timeout in ms. Defaults to 30000. */
  timeoutMs?: number;
  /** Injectable fetch (for testing). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Create a {@link UsageProvider} backed by the Neon consumption API
 * (`GET /consumption_history/projects`). The Neon API is an **untrusted upstream**: timeouts and a
 * schema-validated response (topic-api-consumption); the API key is a secret and is never logged.
 *
 * @param options - API key, org id, and optional granularity / base URL / timeout / fetch.
 * @returns A usage provider.
 */
export function createNeonUsageProvider(options: NeonUsageOptions): UsageProvider {
  const baseUrl = (options.baseUrl ?? 'https://console.neon.tech/api/v2').replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 30_000;
  const granularity = options.granularity ?? 'daily';
  const doFetch = options.fetchImpl ?? globalThis.fetch;

  return {
    async getProjectConsumption(
      neonProjectId: string,
      period: BillingPeriod,
    ): Promise<Consumption[]> {
      const query = new URLSearchParams({
        from: period.from.toISOString(),
        to: period.to.toISOString(),
        granularity,
        org_id: options.orgId,
        project_ids: neonProjectId,
        limit: '100',
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let json: unknown;
      try {
        const response = await doFetch(
          `${baseUrl}/consumption_history/projects?${query.toString()}`,
          {
            method: 'GET',
            headers: { authorization: `Bearer ${options.apiKey}`, accept: 'application/json' },
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          let detail = '';
          try {
            detail = (await response.text()).slice(0, 200);
          } catch {
            detail = '';
          }
          throw new Error(`Neon consumption API failed: HTTP ${response.status} ${detail}`);
        }
        json = await response.json();
      } finally {
        clearTimeout(timer);
      }
      const parsed = ConsumptionResponseSchema.parse(json);
      return parsed.projects.flatMap((p) =>
        p.periods.flatMap((period_) =>
          period_.consumption.map((c) => ({
            computeTimeSeconds: c.compute_time_seconds,
            activeTimeSeconds: c.active_time_seconds,
            writtenDataBytes: c.written_data_bytes,
            syntheticStorageBytes: c.synthetic_storage_size_bytes,
          })),
        ),
      );
    },
  };
}
