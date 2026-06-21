import { z } from 'zod';
import type { ChargeRequest, ChargeResult, PaymentGateway } from '../../ports/payment-gateway.js';

/** The PaymentIntent fields we depend on from Stripe's response. */
const PaymentIntentSchema = z.object({
  id: z.string(),
  status: z.string(),
});

/** Stripe error envelope (`{ error: { message, code? } }`) for a non-2xx response. */
const StripeErrorSchema = z.object({
  error: z.object({ message: z.string().optional(), code: z.string().optional() }).optional(),
});

/** Options for {@link createStripeGateway}. */
export interface StripeGatewayOptions {
  /**
   * Stripe **secret API key** (`sk_…`) — a secret from the secret manager / env, never committed or
   * logged (`workflow-secrets`).
   */
  secretKey: string;
  /** API base URL. Defaults to Stripe's API; override for a mock/proxy. */
  baseUrl?: string;
  /** Per-request timeout in ms. Defaults to 30000. */
  timeoutMs?: number;
  /** Injectable fetch (for testing). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/** Map Stripe's PaymentIntent status to the port's normalized status; throw on a non-terminal/declined one. */
function normalizeStatus(status: string): ChargeResult['status'] {
  switch (status) {
    case 'succeeded':
      return 'succeeded';
    case 'processing':
      return 'processing';
    case 'requires_action':
    case 'requires_confirmation':
      return 'requires_action';
    default:
      // requires_payment_method / canceled / unknown ⇒ the charge did not go through.
      throw new Error(`stripe charge not completed (payment_intent status: ${status})`);
  }
}

/**
 * Create a {@link PaymentGateway} backed by **Stripe**, over its REST API (no SDK dependency — the
 * REST shape of the Vault / Azure-Key-Vault adapters, with an injectable `fetch`). Charges create a
 * confirmed, **off-session** PaymentIntent against the customer's saved default payment method, with
 * the caller's **idempotency key** on the `Idempotency-Key` header so a retry never double-bills.
 *
 * Stripe is an untrusted, unreliable upstream (`topic-api-consumption`): every call is timeout-bound
 * and the response is schema-validated; a non-2xx (e.g. a card decline / 402) throws with Stripe's
 * message (the caller audits + isolates it). The secret key is never logged. Swap this adapter for
 * any other PSP behind the same port without touching the control plane.
 *
 * @param options - Stripe secret key + optional base URL / timeout / fetch.
 * @returns A Stripe-backed payment gateway.
 */
export function createStripeGateway(options: StripeGatewayOptions): PaymentGateway {
  const baseUrl = (options.baseUrl ?? 'https://api.stripe.com').replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 30_000;
  const doFetch = options.fetchImpl ?? globalThis.fetch;

  return {
    provider: 'stripe',
    async charge(request: ChargeRequest): Promise<ChargeResult> {
      // Form-encoded PaymentIntent: confirmed + off-session against the customer's default method.
      const body = new URLSearchParams({
        amount: String(request.amountMinor),
        currency: request.currency,
        customer: request.customerRef,
        confirm: 'true',
        off_session: 'true',
        ...(request.description !== undefined ? { description: request.description } : {}),
      });
      // Attach metadata as Stripe's `metadata[key]=value` form fields (e.g. tenant_id for webhooks).
      for (const [k, v] of Object.entries(request.metadata ?? {})) {
        body.set(`metadata[${k}]`, v);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await doFetch(`${baseUrl}/v1/payment_intents`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.secretKey}`,
            'content-type': 'application/x-www-form-urlencoded',
            // Stripe de-duplicates retried POSTs sharing this key — the no-double-charge guarantee.
            'idempotency-key': request.idempotencyKey,
          },
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const payload: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const parsed = StripeErrorSchema.safeParse(payload);
        const msg = parsed.success ? parsed.data.error?.message : undefined;
        throw new Error(`stripe charge failed (${res.status}): ${msg ?? 'unknown error'}`);
      }
      const intent = PaymentIntentSchema.parse(payload);
      return {
        id: intent.id,
        status: normalizeStatus(intent.status),
        amountMinor: request.amountMinor,
        currency: request.currency,
        provider: 'stripe',
      };
    },
  };
}
