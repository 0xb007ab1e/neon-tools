import { creditBalanceMinor, creditToApply } from '../core/index.js';
import type {
  CreditConsume,
  CreditEntry,
  CreditGrant,
  CreditLedger,
} from '../ports/credit-ledger.js';

/** A process-local {@link CreditLedger}, plus a `clear` for tests. */
export interface InMemoryCreditLedger extends CreditLedger {
  /** Drop all entries (test helper). */
  clear(): void;
}

/**
 * Create an in-memory {@link CreditLedger} (process-local) — the default ledger and the one used in
 * tests. Production uses the Postgres adapter (durable, cross-instance). JavaScript's single-threaded
 * execution makes `consume` naturally atomic here; idempotency is enforced by tracking consumed
 * references. The balance math is the shared pure core (`creditBalanceMinor` / `creditToApply`).
 *
 * @param now - Injectable clock returning an ISO-8601 timestamp (defaults to `new Date().toISOString`).
 * @returns An in-memory credit ledger.
 */
export function createInMemoryCreditLedger(now?: () => string): InMemoryCreditLedger {
  const clock = now ?? ((): string => new Date().toISOString());
  const entries: CreditEntry[] = [];
  /** consumed amount per `${tenantId}|${currency}|${reference}` (idempotency). */
  const consumed = new Map<string, number>();

  return {
    grant(grant: CreditGrant): Promise<void> {
      entries.push({
        tenantId: grant.tenantId,
        amountMinor: grant.amountMinor,
        currency: grant.currency.toLowerCase(),
        reason: grant.reason,
        ...(grant.reference !== undefined ? { reference: grant.reference } : {}),
        at: clock(),
      });
      return Promise.resolve();
    },

    consume(request: CreditConsume): Promise<{ consumedMinor: number }> {
      const currency = request.currency.toLowerCase();
      const key = `${request.tenantId}|${currency}|${request.reference}`;
      const prior = consumed.get(key);
      if (prior !== undefined) return Promise.resolve({ consumedMinor: prior }); // idempotent no-op
      const balance = creditBalanceMinor(
        entries.filter((e) => e.tenantId === request.tenantId),
        currency,
      );
      const consumedMinor = creditToApply(balance, request.amountMinor);
      consumed.set(key, consumedMinor);
      if (consumedMinor > 0) {
        entries.push({
          tenantId: request.tenantId,
          amountMinor: -consumedMinor,
          currency,
          reason: request.reason,
          reference: request.reference,
          at: clock(),
        });
      }
      return Promise.resolve({ consumedMinor });
    },

    balance(tenantId: string, currency: string): Promise<number> {
      return Promise.resolve(
        creditBalanceMinor(
          entries.filter((e) => e.tenantId === tenantId),
          currency,
        ),
      );
    },

    history(tenantId: string, limit: number): Promise<CreditEntry[]> {
      const rows = entries
        .filter((e) => e.tenantId === tenantId)
        .slice(-limit)
        .reverse();
      return Promise.resolve(rows);
    },

    clear(): void {
      entries.length = 0;
      consumed.clear();
    },
  };
}
