/** A request to charge a customer a fixed amount (already computed in minor units). */
export interface ChargeRequest {
  /** Integer amount in the currency's minor units (e.g. cents). */
  amountMinor: number;
  /** Lowercase ISO 4217 currency code (e.g. `usd`). */
  currency: string;
  /**
   * The PSP's customer reference (e.g. a Stripe `cus_…` id). Derived server-side from the tenant's
   * stored billing metadata — never from client input. The PSP charges this customer's saved,
   * default payment method.
   */
  customerRef: string;
  /**
   * Idempotency key — the gateway MUST pass it to the PSP so a retried charge is de-duplicated and a
   * customer is never double-billed (see {@link import('../core/billing.js').chargeIdempotencyKey}).
   */
  idempotencyKey: string;
  /** Optional human-readable description attached to the charge (no secrets/PII). */
  description?: string;
}

/** The outcome of a charge attempt (no card data — safe to log/audit). */
export interface ChargeResult {
  /** The PSP's charge / payment-intent id. */
  id: string;
  /**
   * Normalized status: `succeeded` (captured), `processing` (async settlement in flight), or
   * `requires_action` (e.g. 3DS — needs the customer). A hard decline is surfaced as a thrown error,
   * not a result, so failure handling is explicit.
   */
  status: 'succeeded' | 'processing' | 'requires_action';
  /** The amount charged, echoed back in minor units. */
  amountMinor: number;
  /** Lowercase ISO 4217 currency. */
  currency: string;
  /** The provider that handled the charge (e.g. `stripe`). */
  provider: string;
}

/**
 * Port: a **payment gateway / PSP** that charges a customer for an invoice total. The single seam
 * the billing integration depends on, so a provider can swap Stripe for Adyen / Braintree / a custom
 * billing agent without touching the control plane (ports & adapters). Treat the PSP as an untrusted,
 * unreliable upstream (`topic-api-consumption`): adapters set timeouts and pass the idempotency key
 * through; declines/transport errors are thrown (the caller audits + isolates them).
 */
export interface PaymentGateway {
  /** A stable provider identifier for audit/reporting (e.g. `stripe`, `noop`). */
  readonly provider: string;
  /**
   * Charge the customer. Idempotent on `request.idempotencyKey`. Returns the charge result on
   * success/processing; throws on a decline or transport/PSP error.
   *
   * @param request - Amount (minor units), currency, customer ref, idempotency key.
   * @returns The charge result (no card data).
   */
  charge(request: ChargeRequest): Promise<ChargeResult>;
}
