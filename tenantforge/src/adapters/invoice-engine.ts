import {
  aggregateConsumption,
  buildInvoice,
  type BillingRates,
  type IncludedUsage,
  type Invoice,
} from '../core/index.js';
import type { BillingPeriod } from '../core/index.js';
import type { UsageProvider } from '../ports/usage-provider.js';
import type { TenantRegistry } from '../ports/tenant-registry.js';

/** Collaborators for {@link createInvoiceEngine}. */
export interface InvoiceEngineDeps {
  /** Tenant registry (look up a tenant; list active tenants; read the plan fee from metadata). */
  registry: TenantRegistry;
  /** Fetches per-tenant consumption (Neon usage API). */
  usageProvider: UsageProvider;
  /** Per-unit billing (sell) rates — the prices charged to tenants. */
  rates: BillingRates;
  /** Injectable clock. Defaults to `() => new Date()`. */
  now?: () => Date;
}

/** A fleet invoice run: one invoice per metered tenant. */
export interface FleetInvoiceReport {
  /** When the run was generated (ISO-8601 UTC). */
  generatedAt: string;
  /** Per-tenant invoices (sorted by tenant id). */
  invoices: Invoice[];
  /** Tenants whose consumption could not be metered (no invoice produced). */
  unmetered: string[];
}

/** Upper bound on tenants scanned per fleet run. */
const MAX_SWEEP = 100_000;

/** Reads a numeric `priceUsd` (the tenant's flat plan fee) from metadata, if present. */
function baseFeeFromMetadata(metadata: Record<string, unknown>): number | undefined {
  const p = metadata.priceUsd;
  return typeof p === 'number' && Number.isFinite(p) ? p : undefined;
}

/** A finite, non-negative number, else undefined (defensive — metadata is operator-set, untyped). */
function nonNegNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * Read per-tenant included allowances from `metadata.includedUsage`, if present. Each dimension is
 * accepted only when it is a finite, non-negative number; anything else is ignored (an absent or
 * malformed allowance bills from the first unit). Returns `undefined` when no valid dimension is set.
 */
function includedFromMetadata(metadata: Record<string, unknown>): IncludedUsage | undefined {
  const raw = metadata.includedUsage;
  if (typeof raw !== 'object' || raw === null) return undefined;
  const u = raw as Record<string, unknown>;
  const included: IncludedUsage = {};
  const compute = nonNegNumber(u.computeTimeSeconds);
  const active = nonNegNumber(u.activeTimeSeconds);
  const storage = nonNegNumber(u.syntheticStorageBytes);
  const written = nonNegNumber(u.writtenDataBytes);
  if (compute !== undefined) included.computeTimeSeconds = compute;
  if (active !== undefined) included.activeTimeSeconds = active;
  if (storage !== undefined) included.syntheticStorageBytes = storage;
  if (written !== undefined) included.writtenDataBytes = written;
  return Object.keys(included).length > 0 ? included : undefined;
}

/** Generates invoice **documents** from metered usage. Does not charge — see {@link buildInvoice}. */
export interface InvoiceEngine {
  /**
   * Generate an invoice for one tenant over `period`: meter its consumption, bill it at the billing
   * rates plus its flat plan fee (tenant `metadata.priceUsd`, if set).
   *
   * @param tenantId - The tenant id.
   * @param period - The billing period.
   * @returns The invoice.
   * @throws Error if the tenant is unknown or has no provisioned project to meter.
   */
  invoice(tenantId: string, period: BillingPeriod): Promise<Invoice>;

  /**
   * Generate invoices for every active tenant over `period`. Failure-isolated — a tenant whose
   * consumption can't be fetched is listed under `unmetered` rather than failing the run.
   *
   * @param period - The billing period.
   * @returns The fleet invoice report.
   */
  invoiceFleet(period: BillingPeriod): Promise<FleetInvoiceReport>;
}

/**
 * Create an {@link InvoiceEngine}. Produces invoice documents (line items + total) from metered
 * usage; it does **not** charge a card. Reuses the usage provider + the pure {@link buildInvoice}.
 *
 * @param deps - Registry, usage provider, billing rates, and optional clock.
 * @returns An invoice engine.
 */
export function createInvoiceEngine(deps: InvoiceEngineDeps): InvoiceEngine {
  const now = deps.now ?? ((): Date => new Date());

  /** Meter one tenant and build its invoice (the project must exist). */
  const invoiceTenant = async (
    tenantId: string,
    neonProjectId: string,
    metadata: Record<string, unknown>,
    period: BillingPeriod,
  ): Promise<Invoice> => {
    const consumption = aggregateConsumption(
      await deps.usageProvider.getProjectConsumption(neonProjectId, period),
    );
    const baseFeeUsd = baseFeeFromMetadata(metadata);
    const included = includedFromMetadata(metadata);
    return buildInvoice(consumption, {
      tenantId,
      period,
      billingRates: deps.rates,
      now: now(),
      ...(baseFeeUsd !== undefined ? { baseFeeUsd } : {}),
      ...(included !== undefined ? { included } : {}),
    });
  };

  return {
    async invoice(tenantId: string, period: BillingPeriod): Promise<Invoice> {
      const tenant = await deps.registry.getById(tenantId);
      if (!tenant) throw new Error(`tenant ${tenantId} not found`);
      if (tenant.neonProjectId === null) {
        throw new Error(`tenant ${tenantId} has no provisioned project to invoice`);
      }
      return invoiceTenant(tenant.id, tenant.neonProjectId, tenant.metadata, period);
    },

    async invoiceFleet(period: BillingPeriod): Promise<FleetInvoiceReport> {
      const active = await deps.registry.list({ status: 'active', limit: MAX_SWEEP });
      const invoices: Invoice[] = [];
      const unmetered: string[] = [];
      for (const tenant of active) {
        if (tenant.neonProjectId === null) {
          unmetered.push(tenant.id);
          continue;
        }
        try {
          invoices.push(
            await invoiceTenant(tenant.id, tenant.neonProjectId, tenant.metadata, period),
          );
        } catch {
          unmetered.push(tenant.id);
        }
      }
      invoices.sort((a, b) => a.tenantId.localeCompare(b.tenantId));
      return { generatedAt: now().toISOString(), invoices, unmetered: unmetered.sort() };
    },
  };
}
