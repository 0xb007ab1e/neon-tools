/** A billing/usage time period. */
export interface BillingPeriod {
  /** Start instant (inclusive). */
  from: Date;
  /** End instant (exclusive). */
  to: Date;
}

/**
 * A tenant's resource consumption over a period (mirrors Neon's consumption metrics). Cumulative
 * metrics (compute/active/written) are summed across the period; storage is a size, so it is the
 * peak observed (not summed).
 */
export interface Consumption {
  /** CPU-seconds used by the project's computes. */
  computeTimeSeconds: number;
  /** Seconds the project's computes were active. */
  activeTimeSeconds: number;
  /** Bytes written across the project's branches. */
  writtenDataBytes: number;
  /** Peak storage occupied (bytes). */
  syntheticStorageBytes: number;
}

/** A tenant's usage report for a period. */
export interface TenantUsage {
  /** The tenant. */
  tenantId: string;
  /** The Neon project metered. */
  neonProjectId: string;
  /** The period, as ISO-8601 instants. */
  period: { from: string; to: string };
  /** Aggregated consumption over the period. */
  consumption: Consumption;
}

const ZERO: Consumption = {
  computeTimeSeconds: 0,
  activeTimeSeconds: 0,
  writtenDataBytes: 0,
  syntheticStorageBytes: 0,
};

/**
 * Validate a billing period: both bounds are real dates and `from` is not after `to`. Pure — fail
 * closed on an inverted or invalid range (master §2, topic-numeric-correctness).
 *
 * @param period - The period to validate.
 * @throws Error if either bound is an invalid date, or `from` is after `to`.
 */
export function assertPeriod(period: BillingPeriod): void {
  const from = period.from.getTime();
  const to = period.to.getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) {
    throw new Error('usage period bounds must be valid dates');
  }
  if (from > to) {
    throw new Error('usage period "from" must not be after "to"');
  }
}

/**
 * Aggregate per-bucket consumption into a period total: **sum** the cumulative metrics
 * (compute/active/written) and take the **peak** storage (a size, not a flow — summing daily
 * storage would over-count). Pure (topic-numeric-correctness).
 *
 * @param buckets - Per-timeframe consumption rows (e.g. daily) from the provider.
 * @returns The aggregated consumption (zeros when there are no buckets).
 */
export function aggregateConsumption(buckets: readonly Consumption[]): Consumption {
  return buckets.reduce<Consumption>(
    (acc, c) => ({
      computeTimeSeconds: acc.computeTimeSeconds + c.computeTimeSeconds,
      activeTimeSeconds: acc.activeTimeSeconds + c.activeTimeSeconds,
      writtenDataBytes: acc.writtenDataBytes + c.writtenDataBytes,
      syntheticStorageBytes: Math.max(acc.syntheticStorageBytes, c.syntheticStorageBytes),
    }),
    { ...ZERO },
  );
}
