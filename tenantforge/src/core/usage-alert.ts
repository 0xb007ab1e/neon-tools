import type { Consumption } from './usage.js';
import type { IncludedUsage } from './invoice.js';

/**
 * One **usage allowance alert** — a tenant has crossed a configured fraction of its plan's included
 * allowance for a metered dimension. This is *operator plan policy* (the allowance the operator
 * defined in {@link IncludedUsage}, and the operator's threshold policy) layered on top of Neon's
 * raw consumption metering — Neon meters the project but has no notion of the operator's per-tenant
 * plan tiers, so approaching-allowance alerting is builder-side, not a Neon feature.
 */
export interface UsageAlert {
  /** The metered dimension that crossed a threshold. */
  metric: keyof Consumption;
  /** Metered usage for the period. */
  used: number;
  /** The plan's included allowance for this dimension (always > 0 when an alert is emitted). */
  included: number;
  /** `used / included`, rounded to 4 decimals (may exceed 1 when already over the allowance). */
  usedFraction: number;
  /** The highest configured threshold (fraction) that `usedFraction` meets or exceeds. */
  thresholdCrossed: number;
  /** Usage beyond the allowance (`max(0, used − included)`) — 0 until the allowance is exceeded. */
  overageUnits: number;
}

/** Fixed dimension order so alert output is deterministic. */
const DIMENSIONS: (keyof Consumption)[] = [
  'computeTimeSeconds',
  'activeTimeSeconds',
  'syntheticStorageBytes',
  'writtenDataBytes',
];

/** Round a fraction to 4 decimals (stable display; not money math). */
function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

/**
 * Normalize alert thresholds: keep only finite, positive fractions, de-duplicate, and sort
 * ascending. A threshold of `0.8` means "80% of the allowance", `1.0` means "at the allowance".
 *
 * @param thresholds - Raw configured thresholds (any order, possibly with junk).
 * @returns The cleaned, ascending, de-duplicated thresholds.
 */
export function normalizeThresholds(thresholds: number[]): number[] {
  const valid = thresholds.filter((t) => Number.isFinite(t) && t > 0);
  return [...new Set(valid)].sort((a, b) => a - b);
}

/**
 * Evaluate a tenant's metered consumption against its plan's {@link IncludedUsage} allowances and a
 * set of alert thresholds, returning one {@link UsageAlert} per dimension that has crossed at least
 * one threshold. Pure and deterministic. Only dimensions with a **positive** allowance are
 * considered (no allowance ⇒ no fraction to alert on). Reuses Neon's consumption (metered upstream)
 * — it does not re-meter; it applies the operator's plan-allowance policy.
 *
 * @param consumption - The tenant's aggregated consumption for the period.
 * @param included - The plan's included allowances (any subset of dimensions).
 * @param thresholds - Alert thresholds as fractions of the allowance (e.g. `[0.8, 1.0]`).
 * @returns Alerts for the crossed dimensions (in a fixed dimension order); empty when none cross.
 */
export function evaluateUsageAlerts(
  consumption: Consumption,
  included: IncludedUsage,
  thresholds: number[],
): UsageAlert[] {
  const sorted = normalizeThresholds(thresholds);
  if (sorted.length === 0) return [];
  const alerts: UsageAlert[] = [];
  for (const metric of DIMENSIONS) {
    const allowance = included[metric];
    if (allowance === undefined || allowance <= 0) continue; // no allowance ⇒ nothing to alert on
    const used = consumption[metric];
    const fraction = used / allowance;
    // The highest configured threshold the usage meets or exceeds (thresholds are ascending).
    let crossed: number | undefined;
    for (const t of sorted) if (fraction >= t) crossed = t;
    if (crossed === undefined) continue;
    alerts.push({
      metric,
      used,
      included: allowance,
      usedFraction: round4(fraction),
      thresholdCrossed: crossed,
      overageUnits: Math.max(0, used - allowance),
    });
  }
  return alerts;
}
