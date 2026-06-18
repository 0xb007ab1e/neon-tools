import { aggregateConsumption, evaluateQuota } from '../core/index.js';
import type { BillingPeriod, Quota, QuotaStatus } from '../core/index.js';
import { type TenantEvent } from '../core/observability.js';
import type { UsageProvider } from '../ports/usage-provider.js';
import type { TenantRegistry } from '../ports/tenant-registry.js';

/** Collaborators for {@link createQuotaEngine}. */
export interface QuotaEngineDeps {
  /** Tenant registry (read the record; list active tenants for a sweep). */
  registry: TenantRegistry;
  /** Fetches per-tenant consumption (Neon usage API). */
  usageProvider: UsageProvider;
  /** Optional audit sink. */
  emit?: (event: TenantEvent) => void;
  /** Injectable clock. Defaults to `() => new Date()`. */
  now?: () => Date;
}

/** The outcome of checking one tenant's usage against its quota. */
export interface QuotaCheckResult {
  /** The tenant id. */
  tenantId: string;
  /** The quota evaluation. */
  status: QuotaStatus;
}

/** The result of a fleet quota sweep. */
export interface QuotaSweepReport {
  /** Active tenants examined. */
  scanned: number;
  /** Tenant ids found over quota this sweep. */
  exceeded: string[];
  /** Tenants the `onBreach` action was applied to (e.g. suspended). */
  enforced: string[];
  /** Tenants that failed to check (isolated — they don't block the sweep). */
  failed: { tenantId: string; error: string }[];
}

/** Upper bound on tenants scanned per sweep. */
const MAX_SWEEP = 100_000;

/** Enforces per-tenant resource quotas against metered consumption (#14). */
export interface QuotaEngine {
  /**
   * Check one active tenant's consumption over `period` against `quota`. Emits a
   * `tenant.quota_checked` event (and `tenant.quota_exceeded` on a breach). Detection only — the
   * caller decides whether to act on `status.exceeded`.
   *
   * @param tenantId - The tenant to check.
   * @param period - The billing period to meter.
   * @param quota - The limits to enforce.
   * @returns The quota check result.
   */
  check(tenantId: string, period: BillingPeriod, quota: Quota): Promise<QuotaCheckResult>;

  /**
   * Check every active tenant against `quota` — the scheduled quota sweep. Failure-isolated. When
   * `onBreach` is supplied, it is invoked for each over-quota tenant (e.g. to suspend it); a tenant
   * is reported under `enforced` only if its `onBreach` succeeds.
   *
   * @param period - The billing period to meter.
   * @param quota - The limits to enforce.
   * @param options - Optional scan cap and a per-breach enforcement action.
   * @returns The sweep report.
   */
  checkAll(
    period: BillingPeriod,
    quota: Quota,
    options?: { limit?: number; onBreach?: (tenantId: string) => Promise<void> },
  ): Promise<QuotaSweepReport>;
}

/**
 * Create a {@link QuotaEngine} that meters each tenant's consumption (via the usage provider) and
 * evaluates it against a {@link Quota} with the pure {@link evaluateQuota}. Detection emits audit
 * events; *enforcement* (e.g. suspending an over-quota tenant) is an opt-in `onBreach` action the
 * caller supplies — auto-suspending a tenant is impactful, so it is never the default.
 *
 * @param deps - Registry, usage provider, and optional audit / clock.
 * @returns A quota engine.
 */
export function createQuotaEngine(deps: QuotaEngineDeps): QuotaEngine {
  const now = deps.now ?? ((): Date => new Date());

  const check = async (
    tenantId: string,
    period: BillingPeriod,
    quota: Quota,
  ): Promise<QuotaCheckResult> => {
    const tenant = await deps.registry.getById(tenantId);
    if (tenant === null) throw new Error(`quota: tenant not found: ${tenantId}`);
    if (tenant.status !== 'active' || tenant.neonProjectId === null) {
      throw new Error(`quota: tenant ${tenantId} must be active and provisioned`);
    }
    const consumption = aggregateConsumption(
      await deps.usageProvider.getProjectConsumption(tenant.neonProjectId, period),
    );
    const status = evaluateQuota(consumption, quota);
    deps.emit?.({
      event: status.exceeded ? 'tenant.quota_exceeded' : 'tenant.quota_checked',
      at: now().toISOString(),
      outcome: status.exceeded ? 'error' : 'ok',
      tenantId,
      context: { exceeded: status.exceeded, breaches: status.breaches.map((b) => b.metric) },
    });
    return { tenantId, status };
  };

  return {
    check,

    async checkAll(
      period: BillingPeriod,
      quota: Quota,
      options: { limit?: number; onBreach?: (tenantId: string) => Promise<void> } = {},
    ): Promise<QuotaSweepReport> {
      const active = await deps.registry.list({
        status: 'active',
        limit: options.limit ?? MAX_SWEEP,
      });
      const exceeded: string[] = [];
      const enforced: string[] = [];
      const failed: { tenantId: string; error: string }[] = [];
      for (const tenant of active) {
        try {
          const { status } = await check(tenant.id, period, quota);
          if (status.exceeded) {
            exceeded.push(tenant.id);
            if (options.onBreach !== undefined) {
              await options.onBreach(tenant.id);
              enforced.push(tenant.id);
            }
          }
        } catch (error) {
          failed.push({
            tenantId: tenant.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      deps.emit?.({
        event: 'tenant.quota_sweep',
        at: now().toISOString(),
        outcome: failed.length > 0 ? 'error' : 'ok',
        context: {
          scanned: active.length,
          exceeded: exceeded.length,
          enforced: enforced.length,
          failed: failed.length,
        },
      });
      return { scanned: active.length, exceeded, enforced, failed };
    },
  };
}
