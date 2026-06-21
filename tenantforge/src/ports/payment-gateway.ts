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
  /**
   * Optional key/value metadata to attach to the charge at the PSP (e.g. `{ tenant_id }`), so inbound
   * webhooks can be correlated back to the tenant. No secrets/PII.
   */
  metadata?: Record<string, string>;
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

/** A request to refund (fully or partially) a prior charge. */
export interface RefundRequest {
  /** The PSP charge / payment-intent id to refund (from a prior {@link ChargeResult}). */
  chargeId: string;
  /**
   * Amount to refund in minor units. Omit for a **full** refund of the original charge; provide a
   * positive integer ≤ the original amount for a **partial** refund.
   */
  amountMinor?: number;
  /** Lowercase ISO 4217 currency code (e.g. `usd`) — for validation/reporting symmetry with charge. */
  currency: string;
  /**
   * Idempotency key — the gateway MUST pass it to the PSP so a retried refund is de-duplicated and a
   * customer is never double-refunded (see {@link import('../core/billing.js').refundIdempotencyKey}).
   */
  idempotencyKey: string;
  /** Optional reason for the refund (no secrets/PII); attached at the PSP where supported. */
  reason?: string;
  /** Optional key/value metadata to attach at the PSP (e.g. `{ tenant_id }`). No secrets/PII. */
  metadata?: Record<string, string>;
}

/** The outcome of a refund attempt (no card data — safe to log/audit). */
export interface RefundResult {
  /** The PSP's refund id. */
  id: string;
  /**
   * Normalized status: `succeeded` (refunded) or `pending` (async settlement in flight). A failed
   * refund is surfaced as a thrown error, not a result, so failure handling is explicit.
   */
  status: 'succeeded' | 'pending';
  /** The amount refunded, echoed back in minor units. */
  amountMinor: number;
  /** Lowercase ISO 4217 currency. */
  currency: string;
  /** The provider that handled the refund (e.g. `stripe`). */
  provider: string;
}

/**
 * Port: a **payment gateway / PSP** that charges a customer for an invoice total (and refunds it).
 * The single seam the billing integration depends on, so a provider can swap Stripe for Adyen /
 * Braintree / a custom billing agent without touching the control plane (ports & adapters). Treat
 * the PSP as an untrusted, unreliable upstream (`topic-api-consumption`): adapters set timeouts and
 * pass the idempotency key through; declines/transport errors are thrown (the caller audits +
 * isolates them).
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
  /**
   * Refund a prior charge (full or partial). Idempotent on `request.idempotencyKey` so a retried
   * refund never double-refunds. Returns the refund result on success/pending; throws on a PSP error
   * (e.g. already-refunded, charge not found, transport).
   *
   * @param request - Charge id, optional partial amount, currency, idempotency key.
   * @returns The refund result (no card data).
   */
  refund(request: RefundRequest): Promise<RefundResult>;
}
