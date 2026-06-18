import type { Consumption } from './usage.js';

/**
 * Per-tenant resource limits over a billing period. Each limit is optional; an unset limit is not
 * enforced. Limits map to the {@link Consumption} metrics.
 */
export interface Quota {
  /** Max CPU-seconds. */
  maxComputeTimeSeconds?: number;
  /** Max active-compute seconds. */
  maxActiveTimeSeconds?: number;
  /** Max bytes written over the period. */
  maxWrittenDataBytes?: number;
  /** Max peak storage (bytes). */
  maxStorageBytes?: number;
}

/** A single exceeded limit. */
export interface QuotaBreach {
  /** The consumption metric that exceeded its limit. */
  metric: keyof Consumption;
  /** The configured limit. */
  limit: number;
  /** The observed value. */
  actual: number;
}

/** The result of evaluating consumption against a quota. */
export interface QuotaStatus {
  /** True iff any set limit was exceeded. */
  exceeded: boolean;
  /** The limits that were exceeded (empty when within quota). */
  breaches: QuotaBreach[];
}

/** Mapping of quota limit → the consumption metric it bounds. */
const LIMITS: ReadonlyArray<{ key: keyof Quota; metric: keyof Consumption }> = [
  { key: 'maxComputeTimeSeconds', metric: 'computeTimeSeconds' },
  { key: 'maxActiveTimeSeconds', metric: 'activeTimeSeconds' },
  { key: 'maxWrittenDataBytes', metric: 'writtenDataBytes' },
  { key: 'maxStorageBytes', metric: 'syntheticStorageBytes' },
];

/**
 * Evaluate a tenant's consumption against a quota: for each *set* limit, a breach is recorded when
 * the corresponding metric strictly exceeds it. Pure and deterministic; an empty quota never
 * breaches (no enforcement). The caller decides what to do with a breach (alert / suspend).
 *
 * @param consumption - The tenant's aggregated consumption over the period.
 * @param quota - The per-tenant limits (unset limits are not enforced).
 * @returns The quota status (exceeded + the list of breaches).
 */
export function evaluateQuota(consumption: Consumption, quota: Quota): QuotaStatus {
  const breaches: QuotaBreach[] = [];
  for (const { key, metric } of LIMITS) {
    const limit = quota[key];
    if (limit !== undefined && consumption[metric] > limit) {
      breaches.push({ metric, limit, actual: consumption[metric] });
    }
  }
  return { exceeded: breaches.length > 0, breaches };
}
