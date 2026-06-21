import type { Consumption } from './usage.js';

/**
 * Per-unit **billing** rates (USD) — the prices the operator *charges* a tenant for usage (distinct
 * from {@link import('./cost.js').CostRates}, which are Neon's wholesale *cost* to the operator).
 * Unset dimensions are not billed (no line item). The operator owns these.
 */
export interface BillingRates {
  /** USD charged per CPU-second. */
  computeSecondUsd?: number;
  /** USD charged per active-compute second. */
  activeSecondUsd?: number;
  /** USD charged per byte of peak storage for the period. */
  storageByteUsd?: number;
  /** USD charged per byte written. */
  writtenByteUsd?: number;
}

/**
 * Per-period **included allowances** — the usage a tenant's plan covers for free before any
 * overage is billed. Each unset dimension means **no allowance** (billed from the first unit, the
 * pre-allowance default). Distinct from {@link import('./quota.js').Quota}, which is a *hard
 * enforcement* limit (suspend the tenant): an allowance only shifts where billing starts, it never
 * blocks usage. The operator owns these (e.g. a tenant's plan SKU); they live in tenant metadata.
 */
export interface IncludedUsage {
  /** CPU-seconds included before compute overage is billed. */
  computeTimeSeconds?: number;
  /** Active-compute seconds included before active-time overage is billed. */
  activeTimeSeconds?: number;
  /** Bytes of peak storage included before storage overage is billed. */
  syntheticStorageBytes?: number;
  /** Bytes written included before data-written overage is billed. */
  writtenDataBytes?: number;
}

/**
 * Subtract a tenant's {@link IncludedUsage} allowances from its metered {@link Consumption}, leaving
 * the **billable overage** per dimension (clamped at zero — never negative). Pure and deterministic;
 * an unset/absent allowance subtracts nothing.
 *
 * @param consumption - The tenant's metered consumption for the period.
 * @param included - The plan's included allowances (any subset of dimensions).
 * @returns Consumption reduced by the allowances (each dimension `max(0, used - allowance)`).
 */
export function applyIncludedAllowance(
  consumption: Consumption,
  included: IncludedUsage,
): Consumption {
  const over = (used: number, allowance: number | undefined): number =>
    Math.max(0, used - (allowance ?? 0));
  return {
    computeTimeSeconds: over(consumption.computeTimeSeconds, included.computeTimeSeconds),
    activeTimeSeconds: over(consumption.activeTimeSeconds, included.activeTimeSeconds),
    writtenDataBytes: over(consumption.writtenDataBytes, included.writtenDataBytes),
    syntheticStorageBytes: over(consumption.syntheticStorageBytes, included.syntheticStorageBytes),
  };
}

/** A single billed line on an invoice. */
export interface InvoiceLineItem {
  /** Human-readable description. */
  description: string;
  /** Metered quantity (in `unit`). */
  quantity: number;
  /** The unit `quantity` is measured in. */
  unit: string;
  /** Price per unit (USD). */
  unitPriceUsd: number;
  /** `quantity * unitPriceUsd`, rounded to cents. */
  amountUsd: number;
}

/** A generated invoice **document** for one tenant + period. An artifact, not a charge. */
export interface Invoice {
  /** The tenant billed. */
  tenantId: string;
  /** Billing period start (ISO-8601 UTC). */
  periodStart: string;
  /** Billing period end (ISO-8601 UTC). */
  periodEnd: string;
  /** ISO 4217 currency code (always USD for now). */
  currency: string;
  /** When the invoice was generated (ISO-8601 UTC). */
  generatedAt: string;
  /** The billed lines (base fee first, then any usage lines). */
  lineItems: InvoiceLineItem[];
  /** Sum of all line amounts (USD, rounded to cents). */
  totalUsd: number;
}

/** Options for {@link buildInvoice}. */
export interface InvoiceOptions {
  /** The tenant being billed. */
  tenantId: string;
  /** The billing period. */
  period: { from: Date; to: Date };
  /** Per-unit charge rates for usage-based lines. */
  billingRates: BillingRates;
  /** Flat base/subscription fee for the period (USD), if any (e.g. the tenant's plan price). */
  baseFeeUsd?: number;
  /**
   * Per-period included allowances; usage within an allowance is free and only the **overage** is
   * billed. Absent ⇒ no allowances (every metered unit is billed — the pre-allowance default).
   */
  included?: IncludedUsage;
  /** ISO 4217 currency code; defaults to `USD`. */
  currency?: string;
  /** Generation instant (injected for determinism). */
  now: Date;
}

/** Round a USD amount to whole cents (round at the boundary; not settlement math). */
function cents(usd: number): number {
  return Math.round(usd * 100) / 100;
}

/**
 * Build an invoice **document** for one tenant from its metered consumption and the operator's
 * billing rates (+ optional flat base fee). Pure and deterministic. This produces a billable
 * artifact (line items + total) — it does **not** charge a card or call a payment processor; wiring
 * the total into Stripe/a PSP is a separate, credential-bearing integration left to the operator.
 *
 * @param consumption - The tenant's aggregated consumption for the period.
 * @param options - Tenant, period, billing rates, optional base fee, currency, and the instant.
 * @returns The invoice.
 */
export function buildInvoice(consumption: Consumption, options: InvoiceOptions): Invoice {
  const lineItems: InvoiceLineItem[] = [];

  if (options.baseFeeUsd !== undefined && options.baseFeeUsd > 0) {
    lineItems.push({
      description: 'Base plan fee',
      quantity: 1,
      unit: 'period',
      unitPriceUsd: options.baseFeeUsd,
      amountUsd: cents(options.baseFeeUsd),
    });
  }

  const included = options.included;
  const dimensions: {
    rate: number | undefined;
    quantity: number;
    allowance: number | undefined;
    unit: string;
    description: string;
  }[] = [
    {
      rate: options.billingRates.computeSecondUsd,
      quantity: consumption.computeTimeSeconds,
      allowance: included?.computeTimeSeconds,
      unit: 'compute-second',
      description: 'Compute time',
    },
    {
      rate: options.billingRates.activeSecondUsd,
      quantity: consumption.activeTimeSeconds,
      allowance: included?.activeTimeSeconds,
      unit: 'active-second',
      description: 'Active compute time',
    },
    {
      rate: options.billingRates.storageByteUsd,
      quantity: consumption.syntheticStorageBytes,
      allowance: included?.syntheticStorageBytes,
      unit: 'byte-period',
      description: 'Storage (peak)',
    },
    {
      rate: options.billingRates.writtenByteUsd,
      quantity: consumption.writtenDataBytes,
      allowance: included?.writtenDataBytes,
      unit: 'byte',
      description: 'Data written',
    },
  ];
  for (const d of dimensions) {
    if (d.rate === undefined) continue; // unset rate ⇒ not billed
    // An allowance shifts where billing starts: bill only the overage (max(0, used − allowance)).
    const allowance = d.allowance !== undefined && d.allowance > 0 ? d.allowance : 0;
    const billable = Math.max(0, d.quantity - allowance);
    // Fully within an allowance ⇒ emit no line (no zero-amount overage row). With no allowance the
    // pre-allowance behavior is preserved: a set rate always produces a line, even at quantity 0.
    if (allowance > 0 && billable === 0) continue;
    lineItems.push({
      description:
        allowance > 0 ? `${d.description} (overage; ${allowance} ${d.unit} incl.)` : d.description,
      quantity: allowance > 0 ? billable : d.quantity,
      unit: d.unit,
      unitPriceUsd: d.rate,
      amountUsd: cents((allowance > 0 ? billable : d.quantity) * d.rate),
    });
  }

  return {
    tenantId: options.tenantId,
    periodStart: options.period.from.toISOString(),
    periodEnd: options.period.to.toISOString(),
    currency: options.currency ?? 'USD',
    generatedAt: options.now.toISOString(),
    lineItems,
    totalUsd: cents(lineItems.reduce((sum, li) => sum + li.amountUsd, 0)),
  };
}
