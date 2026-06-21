/**
 * The data an invoice email is rendered from — safe display fields only (no card data, no recipient
 * address; those live outside the pure core and out of the audit trail — master §5).
 */
export interface InvoiceEmailData {
  /** The tenant's display name (slug). */
  tenantSlug: string;
  /** Billing period start (ISO-8601 UTC). */
  periodStart: string;
  /** Billing period end (ISO-8601 UTC). */
  periodEnd: string;
  /** ISO 4217 currency code (e.g. `USD`). */
  currency: string;
  /** The billed lines (description + USD amount). */
  lineItems: { description: string; amountUsd: number }[];
  /** Invoice total (USD). */
  totalUsd: number;
}

/** A rendered invoice email: subject + plain-text body, ready for a notifier. */
export interface RenderedInvoiceEmail {
  /** The notification subject. */
  subject: string;
  /** The plain-text body. */
  body: string;
}

/** Format a USD amount for display (e.g. `12.5 → "12.50 USD"`). Pure. */
function money(amountUsd: number, currency: string): string {
  return `${amountUsd.toFixed(2)} ${currency.toUpperCase()}`;
}

/**
 * Render an invoice **document** to a subject + plain-text body — pure and deterministic, so it
 * unit-tests without sending anything. Lists each line item and the total; contains only safe
 * fields (tenant name, period, amounts) — never card data, secrets, or the recipient address.
 *
 * @param data - The invoice email data.
 * @returns The rendered subject + body.
 */
export function renderInvoiceEmail(data: InvoiceEmailData): RenderedInvoiceEmail {
  const total = money(data.totalUsd, data.currency);
  const lines =
    data.lineItems.length > 0
      ? data.lineItems
          .map((li) => `  • ${li.description}: ${money(li.amountUsd, data.currency)}`)
          .join('\n')
      : '  (no billable lines)';
  return {
    subject: `Your invoice for ${data.periodStart.slice(0, 10)}–${data.periodEnd.slice(0, 10)}: ${total}`,
    body:
      `Hi ${data.tenantSlug},\n\n` +
      `Here is your invoice for the period ${data.periodStart} to ${data.periodEnd}:\n\n` +
      `${lines}\n\n` +
      `Total: ${total}\n\n` +
      `Thanks,\nThe team`,
  };
}

/**
 * Derive a **stable idempotency key** for an invoice email — pure and deterministic, so re-sending
 * after a retry / at-least-once redelivery is de-duplicated and a tenant is never double-billed by
 * email for the same period.
 *
 * @param tenantId - The tenant id.
 * @param periodStart - Billing period start (ISO-8601 UTC).
 * @param periodEnd - Billing period end (ISO-8601 UTC).
 * @returns A deterministic idempotency key.
 */
export function invoiceEmailIdempotencyKey(
  tenantId: string,
  periodStart: string,
  periodEnd: string,
): string {
  return `tenantforge:invoice-email:${tenantId}:${periodStart}..${periodEnd}`;
}
