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

  const dimensions: {
    rate: number | undefined;
    quantity: number;
    unit: string;
    description: string;
  }[] = [
    {
      rate: options.billingRates.computeSecondUsd,
      quantity: consumption.computeTimeSeconds,
      unit: 'compute-second',
      description: 'Compute time',
    },
    {
      rate: options.billingRates.activeSecondUsd,
      quantity: consumption.activeTimeSeconds,
      unit: 'active-second',
      description: 'Active compute time',
    },
    {
      rate: options.billingRates.storageByteUsd,
      quantity: consumption.syntheticStorageBytes,
      unit: 'byte-period',
      description: 'Storage (peak)',
    },
    {
      rate: options.billingRates.writtenByteUsd,
      quantity: consumption.writtenDataBytes,
      unit: 'byte',
      description: 'Data written',
    },
  ];
  for (const d of dimensions) {
    if (d.rate === undefined) continue; // unset rate ⇒ not billed
    lineItems.push({
      description: d.description,
      quantity: d.quantity,
      unit: d.unit,
      unitPriceUsd: d.rate,
      amountUsd: cents(d.quantity * d.rate),
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
