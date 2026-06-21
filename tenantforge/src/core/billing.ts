import type { Invoice } from './invoice.js';

/** A chargeable amount in the currency's **minor units** (e.g. cents) — never floating dollars. */
export interface ChargeAmount {
  /** Integer amount in the smallest currency unit (e.g. 1234 = $12.34). */
  amountMinor: number;
  /** Lowercase ISO 4217 currency code (the form most PSPs expect, e.g. `usd`). */
  currency: string;
}

/**
 * Convert an invoice total to an integer **minor-unit** charge amount (numeric-correctness: money is
 * never charged as a float). Pure. Fails closed on a non-positive total — there is nothing to charge,
 * and a $0/negative charge is always a bug, never a no-op to paper over.
 *
 * @param invoice - The invoice to charge.
 * @returns The integer minor-unit amount + lowercase currency.
 * @throws Error if the total is not a positive, finite amount.
 */
export function invoiceChargeAmount(invoice: Invoice): ChargeAmount {
  const amountMinor = Math.round(invoice.totalUsd * 100);
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
    throw new Error(
      `invoice for ${invoice.tenantId} has no positive amount to charge ` +
        `(total ${invoice.totalUsd} ${invoice.currency})`,
    );
  }
  return { amountMinor, currency: invoice.currency.toLowerCase() };
}

/**
 * Derive a **stable idempotency key** for charging an invoice. Pure and deterministic: the same
 * tenant + period + amount yields the same key, so a retried charge is de-duplicated by the PSP and
 * never double-bills; a corrected amount yields a new key (a genuinely different charge). Readable
 * and bounded for normal ids (PSP idempotency keys are arbitrary strings ≤255 chars).
 *
 * A dunning **retry** must use a *different* key per attempt — otherwise the PSP would replay the
 * original (failed) result instead of making a fresh attempt. Pass the attempt number for retries;
 * the base charge (attempt 0 / omitted) keeps the stable key so an accidental double-call de-dupes.
 *
 * @param invoice - The invoice being charged.
 * @param attempt - Retry attempt number; omit (or 0) for the first/base charge.
 * @returns A deterministic idempotency key.
 */
export function chargeIdempotencyKey(invoice: Invoice, attempt = 0): string {
  const { amountMinor, currency } = invoiceChargeAmount(invoice);
  const base = `tenantforge:charge:${invoice.tenantId}:${invoice.periodStart}..${invoice.periodEnd}:${amountMinor}${currency}`;
  return attempt > 0 ? `${base}:retry-${attempt}` : base;
}

/**
 * Validate a **partial-refund** amount (minor units). Pure; fails closed. A refund amount, when
 * given, must be a positive integer and — when the original charge amount is known — no greater than
 * it (you can't refund more than was charged). `undefined` means a full refund and is always valid.
 *
 * @param amountMinor - The requested refund amount in minor units, or `undefined` for a full refund.
 * @param originalAmountMinor - The original charge amount, when known, to bound a partial refund.
 * @throws Error if the amount is not a positive integer, or exceeds the original charge.
 */
export function assertRefundAmount(amountMinor?: number, originalAmountMinor?: number): void {
  if (amountMinor === undefined) return; // full refund
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new Error(`refund amount must be a positive integer in minor units, got ${amountMinor}`);
  }
  if (originalAmountMinor !== undefined && amountMinor > originalAmountMinor) {
    throw new Error(
      `refund amount ${amountMinor} exceeds the original charge ${originalAmountMinor}`,
    );
  }
}

/**
 * Derive a **stable idempotency key** for refunding a charge. Pure and deterministic: the same
 * charge + amount yields the same key, so a retried refund is de-duplicated by the PSP and never
 * double-refunds; a different partial amount yields a distinct key (a genuinely separate refund).
 * A full refund and a partial refund of the same charge get distinct keys.
 *
 * @param chargeId - The PSP charge id being refunded.
 * @param amountMinor - The partial-refund amount; omit for a full refund.
 * @returns A deterministic idempotency key.
 */
export function refundIdempotencyKey(chargeId: string, amountMinor?: number): string {
  const suffix = amountMinor === undefined ? 'full' : String(amountMinor);
  return `tenantforge:refund:${chargeId}:${suffix}`;
}
