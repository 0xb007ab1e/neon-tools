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
