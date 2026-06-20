import type { Consumption } from './usage.js';

/**
 * Operator-supplied unit cost rates (USD) for Neon consumption — Neon's published prices for the
 * builder's plan. Unset rates contribute 0. The builder owns these (Neon's prices change), so they
 * are configuration, not hard-coded.
 */
export interface CostRates {
  /** USD per CPU-second. */
  computeSecondUsd?: number;
  /** USD per active-compute second. */
  activeSecondUsd?: number;
  /** USD per byte of peak storage for the period. */
  storageByteUsd?: number;
  /** USD per byte written. */
  writtenByteUsd?: number;
}

/** Per-tenant cost vs. price for the period. */
export interface TenantCost {
  /** The tenant id. */
  tenantId: string;
  /** Estimated Neon cost for the tenant (USD, rounded to cents). */
  costUsd: number;
  /** The operator's price for the tenant (USD), or null when not known. */
  priceUsd: number | null;
  /** `priceUsd - costUsd` (USD, rounded), or null when the price is unknown. */
  marginUsd: number | null;
  /** True when the price is known and below cost (loss-making). */
  unprofitable: boolean;
}

/** A fleet cost/margin report. Estimates for attribution — not an invoice. */
export interface CostReport {
  /** When the report was generated (ISO-8601 UTC). */
  generatedAt: string;
  /** Per-tenant rows, sorted by tenant id. */
  rows: TenantCost[];
  /** Tenants whose consumption could not be metered (excluded from totals). */
  unmetered: string[];
  /** Fleet totals (known-price tenants only for price/margin). */
  totals: {
    tenants: number;
    costUsd: number;
    priceUsd: number;
    marginUsd: number;
    unprofitable: number;
    unpriced: number;
  };
}

/** A metered tenant: its aggregated consumption + the operator's price (if known). */
export interface TenantUsageRow {
  tenantId: string;
  consumption: Consumption;
  priceUsd?: number;
}

/** Round a USD amount to whole cents (estimates round at the boundary; not settlement math). */
function cents(usd: number): number {
  return Math.round(usd * 100) / 100;
}

/**
 * Estimate a tenant's Neon cost from its consumption and the unit rates (USD). Pure; unset rates
 * contribute nothing. Returns a raw (unrounded) figure.
 *
 * @param c - Aggregated consumption over the period.
 * @param rates - Unit cost rates.
 * @returns Estimated cost in USD (unrounded).
 */
export function estimateCostUsd(c: Consumption, rates: CostRates): number {
  return (
    c.computeTimeSeconds * (rates.computeSecondUsd ?? 0) +
    c.activeTimeSeconds * (rates.activeSecondUsd ?? 0) +
    c.syntheticStorageBytes * (rates.storageByteUsd ?? 0) +
    c.writtenDataBytes * (rates.writtenByteUsd ?? 0)
  );
}

/**
 * Build a fleet cost/margin report from metered tenants and the unit rates. Pure and deterministic
 * (rows sorted by id; amounts rounded to cents). Margin/price totals count only tenants with a known
 * price. An **estimate** for cost attribution (which tenants cost more than they pay) — not billing.
 *
 * @param usage - Per-tenant consumption + optional price.
 * @param options - Rates, generation instant, and ids that could not be metered.
 * @returns The cost report.
 */
export function buildCostReport(
  usage: readonly TenantUsageRow[],
  options: { rates: CostRates; now: Date; unmetered?: readonly string[] },
): CostReport {
  const rows: TenantCost[] = usage
    .map((u) => {
      const costUsd = cents(estimateCostUsd(u.consumption, options.rates));
      const priceUsd = u.priceUsd ?? null;
      const marginUsd = priceUsd === null ? null : cents(priceUsd - costUsd);
      return {
        tenantId: u.tenantId,
        costUsd,
        priceUsd,
        marginUsd,
        unprofitable: priceUsd !== null && priceUsd < costUsd,
      };
    })
    .sort((a, b) => a.tenantId.localeCompare(b.tenantId));

  // Type-narrow to priced rows so the totals need no (unreachable) null fallbacks.
  const priced = rows.filter(
    (r): r is TenantCost & { priceUsd: number; marginUsd: number } => r.priceUsd !== null,
  );
  return {
    generatedAt: options.now.toISOString(),
    rows,
    unmetered: [...(options.unmetered ?? [])].sort(),
    totals: {
      tenants: rows.length,
      costUsd: cents(rows.reduce((s, r) => s + r.costUsd, 0)),
      priceUsd: cents(priced.reduce((s, r) => s + r.priceUsd, 0)),
      marginUsd: cents(priced.reduce((s, r) => s + r.marginUsd, 0)),
      unprofitable: rows.filter((r) => r.unprofitable).length,
      unpriced: rows.length - priced.length,
    },
  };
}
