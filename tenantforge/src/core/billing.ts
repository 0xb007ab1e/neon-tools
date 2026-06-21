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

/** Inputs to {@link prorateRefundMinor}: the original charge and the period it covered. */
export interface ProrationInput {
  /** The original charge amount in minor units (positive integer). */
  chargeAmountMinor: number;
  /** Period start (ISO-8601) the charge covered. */
  periodStart: string;
  /** Period end (ISO-8601) the charge covered. */
  periodEnd: string;
  /** The instant to prorate as of (e.g. the offboard time, ISO-8601). */
  asOf: string;
}

/**
 * Compute the **prorated refund** (minor units) for the *unused* portion of a charged period — the
 * money to return when a tenant offboards mid-period. Pure and deterministic (numeric-correctness:
 * integer minor units, explicit rounding). The unused fraction is `(periodEnd - asOf) / (periodEnd -
 * periodStart)`, clamped so:
 *
 * - `asOf` at/before the period start ⇒ the whole period is unused ⇒ full refund.
 * - `asOf` at/after the period end ⇒ the period is fully consumed ⇒ refund `0`.
 * - otherwise ⇒ `round(chargeAmountMinor × unusedFraction)`, bounded to `[0, chargeAmountMinor]`.
 *
 * Rounding is half-up (`Math.round`) at the boundary — a sub-cent unused remainder rounds to the
 * nearest minor unit; the result never exceeds the original charge.
 *
 * @param input - Original charge amount + period bounds + the as-of instant.
 * @returns The integer minor-unit amount to refund (0 … chargeAmountMinor).
 * @throws Error if the amount is not a positive integer, or the period bounds are invalid.
 */
export function prorateRefundMinor(input: ProrationInput): number {
  const { chargeAmountMinor } = input;
  if (!Number.isInteger(chargeAmountMinor) || chargeAmountMinor <= 0) {
    throw new Error(`charge amount must be a positive integer, got ${chargeAmountMinor}`);
  }
  const start = Date.parse(input.periodStart);
  const end = Date.parse(input.periodEnd);
  const asOf = Date.parse(input.asOf);
  if (Number.isNaN(start) || Number.isNaN(end) || Number.isNaN(asOf)) {
    throw new Error('proration period/asOf bounds must be valid ISO-8601 dates');
  }
  if (end <= start) {
    throw new Error('proration period end must be after start');
  }
  if (asOf <= start) return chargeAmountMinor; // entire period unused → full refund
  if (asOf >= end) return 0; // period fully consumed → nothing to refund
  const unusedFraction = (end - asOf) / (end - start);
  const refund = Math.round(chargeAmountMinor * unusedFraction);
  return Math.max(0, Math.min(chargeAmountMinor, refund));
}

/** Inputs to {@link proratePlanChangeMinor}: the two plan prices and the period being changed in. */
export interface PlanChangeInput {
  /** The current plan price in minor units. */
  oldPriceMinor: number;
  /** The new plan price in minor units. */
  newPriceMinor: number;
  /** Period start (ISO-8601) the plan applies to. */
  periodStart: string;
  /** Period end (ISO-8601). */
  periodEnd: string;
  /** The instant the change takes effect (ISO-8601). */
  asOf: string;
}

/**
 * Compute the **prorated settlement** (signed minor units) for switching plans mid-period — pure and
 * deterministic. The tenant keeps the old plan for the elapsed fraction and the new plan for the
 * **remaining** fraction `f = (periodEnd - asOf) / (periodEnd - periodStart)`, so the fair adjustment
 * for the rest of the period is `round(f × (newPrice − oldPrice))`:
 *
 * - **positive** ⇒ an **upgrade**; the tenant owes this much for the richer plan's remaining time.
 * - **negative** ⇒ a **downgrade**; this much is owed back (a credit/refund).
 * - **zero** ⇒ same price, or the change lands at/after the period end (nothing left to prorate).
 *
 * A change at/before the period start prorates the **full** price difference (the whole period runs
 * on the new plan). Rounding is half-up at the boundary; prices must be non-negative integers.
 *
 * @param input - The old/new prices (minor units) + period bounds + the as-of instant.
 * @returns The signed minor-unit settlement (charge if &gt; 0, refund if &lt; 0, none if 0).
 * @throws Error if a price is not a non-negative integer, or the period bounds are invalid.
 */
export function proratePlanChangeMinor(input: PlanChangeInput): number {
  for (const [label, v] of [
    ['oldPriceMinor', input.oldPriceMinor],
    ['newPriceMinor', input.newPriceMinor],
  ] as const) {
    if (!Number.isInteger(v) || v < 0) {
      throw new Error(`${label} must be a non-negative integer, got ${v}`);
    }
  }
  const start = Date.parse(input.periodStart);
  const end = Date.parse(input.periodEnd);
  const asOf = Date.parse(input.asOf);
  if (Number.isNaN(start) || Number.isNaN(end) || Number.isNaN(asOf)) {
    throw new Error('plan-change period/asOf bounds must be valid ISO-8601 dates');
  }
  if (end <= start) {
    throw new Error('plan-change period end must be after start');
  }
  const diff = input.newPriceMinor - input.oldPriceMinor;
  if (asOf >= end) return 0; // period over → no remaining time to prorate
  const remainingFraction = asOf <= start ? 1 : (end - asOf) / (end - start);
  return Math.round(diff * remainingFraction);
}
