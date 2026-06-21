/** A normalized inbound payment event (PSP-agnostic) parsed from a verified webhook. */
export interface PaymentEvent {
  /** The PSP's event id — stable, used to de-duplicate at-least-once delivery. */
  id: string;
  /** Normalized event type; `unknown` for PSP events we don't model. */
  type: 'charge.succeeded' | 'charge.failed' | 'charge.refunded' | 'unknown';
  /** The PSP that sent it (e.g. `stripe`). */
  provider: string;
  /** The PSP's original event type, retained for audit/observability (e.g. `payment_intent.succeeded`). */
  rawType: string;
  /** When the PSP recorded the event (ISO-8601 UTC). */
  occurredAt: string;
  /** Our tenant id, if the PSP object carried it in metadata (set at charge time). */
  tenantRef?: string;
  /** The PSP charge / payment-intent id the event concerns. */
  chargeId?: string;
  /** Amount in minor units, if present. */
  amountMinor?: number;
  /** Lowercase ISO 4217 currency, if present. */
  currency?: string;
}

/**
 * Port: verifies and normalizes an **inbound PSP webhook** (e.g. Stripe `payment_intent.succeeded`).
 * The single seam for receiving payment events, so the PSP-specific signature scheme + payload shape
 * are swappable behind one interface — the inbound counterpart to {@link import('./payment-gateway.js').PaymentGateway}.
 *
 * `verify` MUST authenticate the request from the **raw body** (HMAC signature, constant-time
 * compare) and reject stale timestamps (replay defence — `topic-webhooks`); it throws on any invalid
 * / stale / malformed input (the caller returns 4xx and never leaks why). The payload is untrusted
 * input — validate before trusting it.
 */
export interface PaymentWebhookVerifier {
  /** A stable provider identifier for audit/reporting (e.g. `stripe`). */
  readonly provider: string;
  /**
   * Verify the signature over the raw body and parse it into a normalized event.
   *
   * @param rawBody - The exact bytes received (never a re-serialized object — that breaks the HMAC).
   * @param signature - The PSP signature header (e.g. Stripe's `Stripe-Signature`).
   * @returns The normalized payment event.
   * @throws Error on an invalid/stale signature or a malformed payload.
   */
  verify(rawBody: string, signature: string): PaymentEvent;
}
