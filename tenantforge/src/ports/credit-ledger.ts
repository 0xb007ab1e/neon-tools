/** A credit-ledger entry (already-persisted): a signed minor-unit amount in a currency. */
export interface CreditEntry {
  /** The tenant the entry belongs to. */
  tenantId: string;
  /** Signed amount in minor units: `>0` grant, `<0` consumption. */
  amountMinor: number;
  /** Lowercase ISO 4217 currency. */
  currency: string;
  /** Why the entry was made (no secrets/PII). */
  reason: string;
  /** Idempotency anchor for consumptions (e.g. the billing period); absent for grants. */
  reference?: string;
  /** When the entry was made (ISO-8601 UTC). */
  at: string;
}

/** A grant of credit (a positive entry). */
export interface CreditGrant {
  /** The tenant to credit. */
  tenantId: string;
  /** The amount to grant in minor units (must be positive). */
  amountMinor: number;
  /** Lowercase ISO 4217 currency. */
  currency: string;
  /** Why the credit is granted. */
  reason: string;
  /** Optional reference (e.g. the plan-change id). */
  reference?: string;
}

/** A request to consume up to `amountMinor` of a tenant's credit, idempotent on `reference`. */
export interface CreditConsume {
  /** The tenant whose credit to draw down. */
  tenantId: string;
  /** The maximum to consume in minor units (the actual amount is `min(this, balance)`). */
  amountMinor: number;
  /** Lowercase ISO 4217 currency. */
  currency: string;
  /** Why the credit is consumed. */
  reason: string;
  /**
   * Idempotency anchor — re-consuming with the same `(tenantId, currency, reference)` is a **no-op**
   * that returns the original consumed amount, so a re-charge for the same billing period never
   * double-spends credit. Required.
   */
  reference: string;
}

/**
 * Port: a tenant **credit ledger** — an append-only log whose per-(tenant, currency) balance gates
 * money. Distinct from the best-effort audit trail: this is **authoritative** (a dropped write would
 * mis-bill). The default is an in-memory ledger; production uses the Postgres adapter (`tf_credits`).
 * Credits are granted (downgrade proration, goodwill, refund-as-credit) and consumed (applied to a
 * charge), and the balance is `max(0, SUM(amountMinor))`.
 */
export interface CreditLedger {
  /**
   * Add a credit (a positive entry).
   *
   * @param grant - Tenant, amount (minor units, &gt; 0), currency, reason.
   */
  grant(grant: CreditGrant): Promise<void>;
  /**
   * Consume up to `request.amountMinor` of the tenant's balance — **atomic** and **idempotent** on
   * `reference` (a repeat with the same reference returns the originally-consumed amount and consumes
   * nothing more). Never consumes more than the available balance.
   *
   * @param request - Tenant, max amount, currency, reason, idempotency reference.
   * @returns The amount actually consumed (minor units).
   */
  consume(request: CreditConsume): Promise<{ consumedMinor: number }>;
  /**
   * The current balance for a tenant + currency (minor units, never negative).
   *
   * @param tenantId - The tenant.
   * @param currency - The lowercase ISO 4217 currency.
   * @returns The balance in minor units.
   */
  balance(tenantId: string, currency: string): Promise<number>;
  /**
   * A tenant's recent ledger entries, newest-first.
   *
   * @param tenantId - The tenant.
   * @param limit - Max rows.
   * @returns The entries.
   */
  history(tenantId: string, limit: number): Promise<CreditEntry[]>;
}
