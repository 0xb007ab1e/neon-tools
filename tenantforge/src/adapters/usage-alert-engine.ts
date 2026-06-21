import { aggregateConsumption, evaluateUsageAlerts, type UsageAlert } from '../core/index.js';
import type { BillingPeriod } from '../core/index.js';
import { type TenantEvent } from '../core/observability.js';
import type { UsageProvider } from '../ports/usage-provider.js';
import type { TenantRegistry } from '../ports/tenant-registry.js';
import { includedFromMetadata } from './invoice-engine.js';

/** Collaborators for {@link createUsageAlertEngine}. */
export interface UsageAlertEngineDeps {
  /** Tenant registry (read the record; list active tenants for a sweep). */
  registry: TenantRegistry;
  /** Fetches per-tenant consumption (Neon usage API) — metering is Neon's; this only evaluates it. */
  usageProvider: UsageProvider;
  /** Alert thresholds as fractions of the allowance (e.g. `[0.8, 1.0]`). */
  thresholds: number[];
  /** Optional audit sink (alerts fan out as `tenant.usage_alert` events). */
  emit?: (event: TenantEvent) => void;
  /** Injectable clock. Defaults to `() => new Date()`. */
  now?: () => Date;
}

/** One tenant's evaluated usage alerts for a period. */
export interface TenantUsageAlert {
  /** The tenant id. */
  tenantId: string;
  /** The crossed-threshold alerts (empty when the tenant is within all allowances). */
  alerts: UsageAlert[];
}

/** The result of a fleet usage-alert sweep. */
export interface UsageAlertSweepReport {
  /** When the sweep ran (ISO-8601 UTC). */
  generatedAt: string;
  /** Active tenants examined. */
  scanned: number;
  /** Per-tenant alerts, for tenants that crossed at least one threshold (sorted by tenant id). */
  alerted: TenantUsageAlert[];
  /** Tenants that failed to check (isolated — they don't block the sweep). */
  failed: { tenantId: string; error: string }[];
}

/** Upper bound on tenants scanned per sweep. */
const MAX_SWEEP = 100_000;

/**
 * Detects tenants approaching/exceeding their plan's included usage allowances. Builder-side
 * billing policy: it consumes Neon's metered consumption (never re-meters) and applies the
 * operator's per-tenant {@link import('../core/invoice.js').IncludedUsage} allowance + threshold
 * policy — concepts Neon has no knowledge of.
 */
export interface UsageAlertEngine {
  /**
   * Evaluate one active tenant's consumption over `period` against its `metadata.includedUsage`
   * allowances and the configured thresholds.
   *
   * @param tenantId - The tenant to check.
   * @param period - The billing period to meter.
   * @returns The tenant's alerts (possibly empty).
   * @throws Error if the tenant is unknown, not active, or has no provisioned project to meter.
   */
  check(tenantId: string, period: BillingPeriod): Promise<TenantUsageAlert>;

  /**
   * Evaluate every active tenant — the scheduled usage-alert sweep. Failure-isolated: a tenant whose
   * consumption can't be fetched is recorded under `failed`, not allowed to fail the sweep. Emits a
   * `tenant.usage_alert` event per alerted tenant and a `tenant.usage_alert_sweep` summary.
   *
   * @param period - The billing period to meter.
   * @param options - Optional scan cap.
   * @returns The sweep report (only tenants with alerts are listed under `alerted`).
   */
  checkAll(period: BillingPeriod, options?: { limit?: number }): Promise<UsageAlertSweepReport>;
}

/**
 * Create a {@link UsageAlertEngine}. Reuses the usage provider + the pure {@link evaluateUsageAlerts}
 * and the same `metadata.includedUsage` parsing as the invoice engine. Detection + audit only;
 * *notifying* the tenant (email) is layered on by the facade, which owns the notifier + recipient.
 *
 * @param deps - Registry, usage provider, thresholds, and optional audit / clock.
 * @returns A usage-alert engine.
 */
export function createUsageAlertEngine(deps: UsageAlertEngineDeps): UsageAlertEngine {
  const now = deps.now ?? ((): Date => new Date());

  const check = async (tenantId: string, period: BillingPeriod): Promise<TenantUsageAlert> => {
    const tenant = await deps.registry.getById(tenantId);
    if (tenant === null) throw new Error(`usage-alert: tenant not found: ${tenantId}`);
    if (tenant.status !== 'active' || tenant.neonProjectId === null) {
      throw new Error(`usage-alert: tenant ${tenantId} must be active and provisioned`);
    }
    const included = includedFromMetadata(tenant.metadata);
    if (included === undefined) return { tenantId, alerts: [] }; // no allowances ⇒ nothing to alert
    const consumption = aggregateConsumption(
      await deps.usageProvider.getProjectConsumption(tenant.neonProjectId, period),
    );
    const alerts = evaluateUsageAlerts(consumption, included, deps.thresholds);
    if (alerts.length > 0) {
      deps.emit?.({
        event: 'tenant.usage_alert',
        at: now().toISOString(),
        outcome: 'ok',
        tenantId,
        context: {
          alerts: alerts.map((a) => ({
            metric: a.metric,
            usedFraction: a.usedFraction,
            thresholdCrossed: a.thresholdCrossed,
            overageUnits: a.overageUnits,
          })),
        },
      });
    }
    return { tenantId, alerts };
  };

  return {
    check,

    async checkAll(
      period: BillingPeriod,
      options: { limit?: number } = {},
    ): Promise<UsageAlertSweepReport> {
      const active = await deps.registry.list({
        status: 'active',
        limit: options.limit ?? MAX_SWEEP,
      });
      const alerted: TenantUsageAlert[] = [];
      const failed: { tenantId: string; error: string }[] = [];
      for (const tenant of active) {
        try {
          const result = await check(tenant.id, period);
          if (result.alerts.length > 0) alerted.push(result);
        } catch (error) {
          failed.push({
            tenantId: tenant.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      alerted.sort((a, b) => a.tenantId.localeCompare(b.tenantId));
      deps.emit?.({
        event: 'tenant.usage_alert_sweep',
        at: now().toISOString(),
        outcome: failed.length > 0 ? 'error' : 'ok',
        context: { scanned: active.length, alerted: alerted.length, failed: failed.length },
      });
      return { generatedAt: now().toISOString(), scanned: active.length, alerted, failed };
    },
  };
}
