import type { TenantCost } from './cost.js';

/**
 * Thresholds for {@link detectCostAnomalies}. `unprofitable` and `unpriced` are always evaluated
 * (unambiguous); `low-margin` and `high-cost` are opt-in (only when their threshold is set), so the
 * default scan stays low-noise. Operator FinOps policy — Neon has no notion of the operator's
 * prices/margins, so this is builder-side.
 */
export interface CostAnomalyThresholds {
  /** Flag a profitable tenant whose margin (USD) is below this as `low-margin`. Unset ⇒ disabled. */
  minMarginUsd?: number;
  /** Flag a tenant whose cost (USD) is at/above this as `high-cost`. Unset ⇒ disabled. */
  maxCostUsd?: number;
}

/** One detected cost/margin anomaly for a tenant. */
export interface CostAnomaly {
  /** The category (most severe match wins, one per tenant). */
  kind: 'unprofitable' | 'unpriced' | 'low-margin' | 'high-cost';
  /** The tenant. */
  tenantId: string;
  /** Estimated Neon cost (USD). */
  costUsd: number;
  /** Operator price (USD), or null when unknown. */
  priceUsd: number | null;
  /** Margin (USD), or null when the price is unknown. */
  marginUsd: number | null;
}

const SEVERITY: Record<CostAnomaly['kind'], number> = {
  unprofitable: 0,
  unpriced: 1,
  'low-margin': 2,
  'high-cost': 3,
};

/**
 * Classify a single cost row into its most-severe anomaly kind, or `null` when healthy. Priority:
 * unprofitable → unpriced → low-margin → high-cost.
 */
function classify(row: TenantCost, t: CostAnomalyThresholds): CostAnomaly['kind'] | null {
  if (row.marginUsd !== null && row.marginUsd < 0) return 'unprofitable';
  if (row.priceUsd === null && row.costUsd > 0) return 'unpriced';
  if (t.minMarginUsd !== undefined && row.marginUsd !== null && row.marginUsd < t.minMarginUsd) {
    return 'low-margin';
  }
  if (t.maxCostUsd !== undefined && row.costUsd >= t.maxCostUsd) return 'high-cost';
  return null;
}

/**
 * Scan per-tenant cost rows for FinOps anomalies — unprofitable, unpriced-but-consuming, thin
 * margin (opt-in), and high cost (opt-in). Pure and deterministic: at most one (most-severe)
 * finding per tenant, ordered by severity then descending cost then tenant id.
 *
 * @param rows - The per-tenant cost rows (e.g. from a {@link import('./cost.js').CostReport}).
 * @param thresholds - Optional `minMarginUsd` / `maxCostUsd` (opt-in categories).
 * @returns The detected anomalies (empty when none).
 */
export function detectCostAnomalies(
  rows: TenantCost[],
  thresholds: CostAnomalyThresholds = {},
): CostAnomaly[] {
  const findings: CostAnomaly[] = [];
  for (const row of rows) {
    const kind = classify(row, thresholds);
    if (kind === null) continue;
    findings.push({
      kind,
      tenantId: row.tenantId,
      costUsd: row.costUsd,
      priceUsd: row.priceUsd,
      marginUsd: row.marginUsd,
    });
  }
  return findings.sort(
    (a, b) =>
      SEVERITY[a.kind] - SEVERITY[b.kind] ||
      b.costUsd - a.costUsd ||
      a.tenantId.localeCompare(b.tenantId),
  );
}
