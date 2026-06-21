/** One credit-ledger entry: a signed minor-unit amount in a currency (`>0` grant, `<0` consumption). */
export interface CreditEntryAmount {
  /** Signed amount in minor units: positive = grant, negative = consumption. */
  amountMinor: number;
  /** Lowercase ISO 4217 currency. */
  currency: string;
}

/**
 * Sum a tenant's credit entries for one currency into a **balance** (minor units), clamped at zero —
 * pure and deterministic. Grants add, consumptions subtract; the floor of zero is defensive (a
 * correct ledger never over-consumes, but a clamp guarantees the balance is never negative).
 *
 * @param entries - The tenant's credit entries (any currencies).
 * @param currency - The currency to total (lowercased compare).
 * @returns The non-negative balance in minor units.
 */
export function creditBalanceMinor(
  entries: readonly CreditEntryAmount[],
  currency: string,
): number {
  const want = currency.toLowerCase();
  let total = 0;
  for (const e of entries) {
    if (e.currency.toLowerCase() === want) total += e.amountMinor;
  }
  return Math.max(0, total);
}

/**
 * Decide how much credit to apply to an amount due — pure. Never more than the available balance,
 * never more than what's owed, never negative.
 *
 * @param balanceMinor - The available credit balance (minor units).
 * @param amountDueMinor - The amount being charged (minor units).
 * @returns The credit to apply (minor units), in `[0, min(balance, due)]`.
 */
export function creditToApply(balanceMinor: number, amountDueMinor: number): number {
  return Math.max(0, Math.min(balanceMinor, amountDueMinor));
}
