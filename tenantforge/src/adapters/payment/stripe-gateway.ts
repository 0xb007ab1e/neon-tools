import { z } from 'zod';
import type {
  ChargeRequest,
  ChargeResult,
  PaymentGateway,
  RefundRequest,
  RefundResult,
} from '../../ports/payment-gateway.js';
import { assertHttpsUrl } from '../../core/transport-security.js';

/** The PaymentIntent fields we depend on from Stripe's response. */
const PaymentIntentSchema = z.object({
  id: z.string(),
  status: z.string(),
});

/** The Refund fields we depend on from Stripe's response. */
const RefundSchema = z.object({
  id: z.string(),
  status: z.string(),
  amount: z.number().int().nonnegative().optional(),
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
  /** Max attempts for transient failures (network/timeout, 429, 5xx). Defaults to 3. */
  maxAttempts?: number;
  /**
   * Injectable delay between retry attempts (tests pass an instant/no-op sleep for speed +
   * determinism). Defaults to a real `setTimeout`-backed sleep; the backoff duration (exponential +
   * jitter) is computed by the gateway.
   */
  sleep?: (ms: number) => Promise<void>;
  /** Permit a non-https base URL override (local dev / mock only — documented leaky-endpoint opt-out). */
  allowInsecure?: boolean;
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

/** Map Stripe's Refund status to the port's normalized status; throw on a failed/canceled refund. */
function normalizeRefundStatus(status: string): RefundResult['status'] {
  switch (status) {
    case 'succeeded':
      return 'succeeded';
    case 'pending':
      return 'pending';
    default:
      // failed / canceled / requires_action / unknown ⇒ the refund did not go through.
      throw new Error(`stripe refund not completed (status: ${status})`);
  }
}

/**
 * Create a {@link PaymentGateway} backed by **Stripe**, over its REST API (no SDK dependency — the
 * REST shape of the Vault / Azure-Key-Vault adapters, with an injectable `fetch`). Charges create a
 * confirmed, **off-session** PaymentIntent against the customer's saved default payment method, with
 * the caller's **idempotency key** on the `Idempotency-Key` header so a retry never double-bills.
 *
 * Stripe is an untrusted, unreliable upstream (`topic-api-consumption`): every call is timeout-bound,
 * transient failures (network/timeout, 429, 5xx) are retried with bounded exponential backoff + full
 * jitter (safe under the shared idempotency key — no double-billing), and the response is
 * schema-validated; a terminal non-2xx (e.g. a card decline / 402) throws with Stripe's message (the
 * caller audits + isolates it). The secret key is never logged. Swap this adapter for any other PSP
 * behind the same port without touching the control plane.
 *
 * @param options - Stripe secret key + optional base URL / timeout / fetch.
 * @returns A Stripe-backed payment gateway.
 */
export function createStripeGateway(options: StripeGatewayOptions): PaymentGateway {
  const baseUrl = (options.baseUrl ?? 'https://api.stripe.com').replace(/\/+$/, '');
  // The default is https; a custom baseUrl (mock/proxy) must stay TLS too — card-charge traffic.
  assertHttpsUrl(baseUrl, 'STRIPE_API_BASE_URL', options.allowInsecure);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const sleep =
    options.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));

  /**
   * POST a form-encoded body to a Stripe endpoint with the idempotency key + timeout, and return the
   * parsed JSON. **Transient failures (network/timeout, 429, 5xx) are retried** with bounded
   * exponential backoff + full jitter (topic-api-consumption / topic-reliability) — safe because every
   * attempt sends the SAME `Idempotency-Key`, so Stripe de-duplicates a retried charge/refund (no
   * double-billing). A 4xx other than 429 (e.g. a card decline / 402) is a caller error — fail fast,
   * no retry. Throws `stripe {op} failed (status): message` on a terminal non-2xx (the caller isolates
   * it), or `stripe {op} request failed` when the network never responded after all attempts.
   */
  const post = async (
    path: string,
    body: URLSearchParams,
    idempotencyKey: string,
    op: string,
  ): Promise<unknown> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response | undefined;
      try {
        res = await doFetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.secretKey}`,
            'content-type': 'application/x-www-form-urlencoded',
            // Stripe de-duplicates retried POSTs sharing this key — the no-double-charge/refund guarantee.
            'idempotency-key': idempotencyKey,
          },
          body,
          signal: controller.signal,
        });
      } catch (cause) {
        // Network error / timeout — transient (retryable).
        lastError = cause;
      } finally {
        clearTimeout(timer);
      }

      if (res !== undefined) {
        const payload: unknown = await res.json().catch(() => ({}));
        if (res.ok) return payload;
        const parsed = StripeErrorSchema.safeParse(payload);
        const msg = parsed.success ? parsed.data.error?.message : undefined;
        const error = new Error(`stripe ${op} failed (${res.status}): ${msg ?? 'unknown error'}`);
        // 429 + 5xx are transient; any other 4xx (card decline, bad request) is terminal — fail fast.
        const transient = res.status === 429 || res.status >= 500;
        if (!transient || attempt === maxAttempts) throw error;
        lastError = error;
      } else if (attempt === maxAttempts) {
        throw new Error(`stripe ${op} request failed`, { cause: lastError });
      }

      // Full jitter: sleep a random duration in [0, min(cap, base·2^(attempt-1))] before retrying, so
      // concurrent callers don't resynchronize into a thundering herd. Math.random is fine (jitter).
      const backoffCeil = Math.min(2000, 100 * 2 ** (attempt - 1));
      await sleep(Math.floor(Math.random() * backoffCeil));
    }
    // Unreachable: the loop returns or throws on the final attempt. Satisfies the type checker.
    throw lastError instanceof Error ? lastError : new Error(`stripe ${op} failed`);
  };

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
      const intent = PaymentIntentSchema.parse(
        await post('/v1/payment_intents', body, request.idempotencyKey, 'charge'),
      );
      return {
        id: intent.id,
        status: normalizeStatus(intent.status),
        amountMinor: request.amountMinor,
        currency: request.currency,
        provider: 'stripe',
      };
    },
    async refund(request: RefundRequest): Promise<RefundResult> {
      // Refund a PaymentIntent (our charge id is the intent id). Omit `amount` for a full refund.
      const body = new URLSearchParams({ payment_intent: request.chargeId });
      if (request.amountMinor !== undefined) body.set('amount', String(request.amountMinor));
      // Stripe's `reason` is a fixed enum — keep the operator's free-text reason in metadata instead
      // (an arbitrary value would 400). tenant_id etc. ride along the same way.
      for (const [k, v] of Object.entries(request.metadata ?? {})) {
        body.set(`metadata[${k}]`, v);
      }
      if (request.reason !== undefined) body.set('metadata[reason]', request.reason);
      const refund = RefundSchema.parse(
        await post('/v1/refunds', body, request.idempotencyKey, 'refund'),
      );
      return {
        id: refund.id,
        status: normalizeRefundStatus(refund.status),
        // Prefer the amount Stripe actually refunded (it resolves a full refund to the real total);
        // fall back to the requested amount, then 0 if neither is known.
        amountMinor: refund.amount ?? request.amountMinor ?? 0,
        currency: request.currency,
        provider: 'stripe',
      };
    },
  };
}
