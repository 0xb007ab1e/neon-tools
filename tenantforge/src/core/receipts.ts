/** The kind of billing event a receipt confirms. */
export type ReceiptKind = 'charge' | 'refund';

/** The data a receipt is rendered from (no card data, no recipient — those live outside the core). */
export interface ReceiptData {
  /** Whether this confirms a charge or a refund. */
  kind: ReceiptKind;
  /** The tenant's display name (slug) — shown in the receipt. */
  tenantSlug: string;
  /** The amount in minor units (e.g. cents). */
  amountMinor: number;
  /** Lowercase ISO 4217 currency code (e.g. `usd`). */
  currency: string;
  /** The PSP charge/refund id the receipt references. */
  reference: string;
  /** When the charge/refund occurred (ISO-8601 UTC). */
  at: string;
}

/** A rendered receipt: a subject line + a plain-text body, ready for a {@link import('../ports/notifier.js').Notifier}. */
export interface RenderedReceipt {
  /** The notification subject. */
  subject: string;
  /** The plain-text body. */
  body: string;
}

/**
 * Format a minor-unit amount + currency for display (e.g. `1234, usd → "12.34 USD"`). Assumes a
 * **2-decimal** currency (usd/eur/gbp/…); zero/three-decimal currencies (JPY/BHD) would need their
 * own exponent — documented as a known limitation. Pure.
 *
 * @param amountMinor - The amount in minor units.
 * @param currency - The ISO 4217 currency code.
 * @returns A human-readable `"12.34 USD"` string.
 */
export function formatMoney(amountMinor: number, currency: string): string {
  return `${(amountMinor / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

/**
 * Render a charge/refund **receipt** to a subject + plain-text body — pure and deterministic, so it
 * unit-tests without sending anything. Contains only safe fields (amount, currency, reference, date,
 * tenant name) — **never card data, secrets, or the recipient address** (those are the notifier's
 * concern, kept out of the core and out of the audit trail — master §5).
 *
 * @param receipt - The receipt data.
 * @returns The rendered subject + body.
 */
export function renderReceipt(receipt: ReceiptData): RenderedReceipt {
  const money = formatMoney(receipt.amountMinor, receipt.currency);
  if (receipt.kind === 'refund') {
    return {
      subject: `Your refund of ${money}`,
      body:
        `Hi ${receipt.tenantSlug},\n\n` +
        `We've refunded ${money} to your payment method on ${receipt.at}.\n` +
        `Reference: ${receipt.reference}\n\n` +
        `Thanks,\nThe team`,
    };
  }
  return {
    subject: `Your receipt for ${money}`,
    body:
      `Hi ${receipt.tenantSlug},\n\n` +
      `We've charged ${money} to your payment method on ${receipt.at}.\n` +
      `Reference: ${receipt.reference}\n\n` +
      `Thanks,\nThe team`,
  };
}

/**
 * Derive a **stable idempotency key** for a receipt — pure and deterministic, so re-sending after a
 * retry (or an at-least-once redelivery) is de-duplicated and a tenant is never double-notified for
 * the same charge/refund.
 *
 * @param kind - Charge or refund.
 * @param reference - The charge/refund id the receipt confirms.
 * @returns A deterministic idempotency key.
 */
export function receiptIdempotencyKey(kind: ReceiptKind, reference: string): string {
  return `tenantforge:receipt:${kind}:${reference}`;
}
