import {
  aggregateConsumption,
  buildCostReport,
  type CostRates,
  type CostReport,
} from '../core/index.js';
import type { BillingPeriod, TenantUsageRow } from '../core/index.js';
import type { UsageProvider } from '../ports/usage-provider.js';
import type { TenantRegistry } from '../ports/tenant-registry.js';

/** Collaborators for {@link createCostEngine}. */
export interface CostEngineDeps {
  /** Tenant registry (list active tenants; read each tenant's price from metadata). */
  registry: TenantRegistry;
  /** Fetches per-tenant consumption (Neon usage API). */
  usageProvider: UsageProvider;
  /** Unit cost rates (USD) — Neon's prices for the builder's plan. */
  rates: CostRates;
  /** Injectable clock. Defaults to `() => new Date()`. */
  now?: () => Date;
}

/** Upper bound on tenants scanned per report. */
const MAX_SWEEP = 100_000;

/** Reads a numeric `priceUsd` from a tenant's metadata, if present. */
function priceFromMetadata(metadata: Record<string, unknown>): number | undefined {
  const p = metadata.priceUsd;
  return typeof p === 'number' && Number.isFinite(p) ? p : undefined;
}

/** Per-tenant cost/margin attribution from metered consumption (pivot #3). */
export interface CostEngine {
  /**
   * Build a fleet cost/margin report for `period`: meter each active tenant's consumption, estimate
   * its Neon cost from the rates, and compare to the operator's price (tenant `metadata.priceUsd`).
   * Failure-isolated — a tenant whose consumption can't be fetched is listed under `unmetered`.
   *
   * @param period - The billing period to meter.
   * @returns The cost report.
   */
  report(period: BillingPeriod): Promise<CostReport>;
}

/**
 * Create a {@link CostEngine}. Read-only attribution (which tenants cost more than they pay) — it
 * does **not** invoice. Reuses the usage provider + the pure {@link buildCostReport}.
 *
 * @param deps - Registry, usage provider, rates, and optional clock.
 * @returns A cost engine.
 */
export function createCostEngine(deps: CostEngineDeps): CostEngine {
  const now = deps.now ?? ((): Date => new Date());
  return {
    async report(period: BillingPeriod): Promise<CostReport> {
      const active = await deps.registry.list({ status: 'active', limit: MAX_SWEEP });
      const usage: TenantUsageRow[] = [];
      const unmetered: string[] = [];
      for (const tenant of active) {
        if (tenant.neonProjectId === null) {
          unmetered.push(tenant.id);
          continue;
        }
        try {
          const consumption = aggregateConsumption(
            await deps.usageProvider.getProjectConsumption(tenant.neonProjectId, period),
          );
          const price = priceFromMetadata(tenant.metadata);
          usage.push({
            tenantId: tenant.id,
            consumption,
            ...(price !== undefined ? { priceUsd: price } : {}),
          });
        } catch {
          unmetered.push(tenant.id);
        }
      }
      return buildCostReport(usage, { rates: deps.rates, now: now(), unmetered });
    },
  };
}
