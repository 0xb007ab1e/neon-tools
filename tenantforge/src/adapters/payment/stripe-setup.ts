import { z } from 'zod';
import type {
  CreateCustomerRequest,
  CreateCustomerResult,
  CreateSetupIntentRequest,
  CreateSetupIntentResult,
  PaymentSetup,
  SetupIntentState,
} from '../../ports/payment-setup.js';
import { assertHttpsUrl } from '../../core/transport-security.js';

/** The Customer fields we depend on from Stripe's response. */
const CustomerSchema = z.object({ id: z.string() });

/** The SetupIntent fields we depend on from Stripe's response. */
const SetupIntentSchema = z.object({
  id: z.string(),
  status: z.string(),
  client_secret: z.string(),
  customer: z.string(),
  payment_method: z.string().nullable().optional(),
});

/** SetupIntent shape when read back (client_secret not required on GET). */
const SetupIntentStateSchema = z.object({
  id: z.string(),
  status: z.string(),
  customer: z.string(),
  payment_method: z.string().nullable().optional(),
});

/** Stripe error envelope (`{ error: { message, code? } }`) for a non-2xx response. */
const StripeErrorSchema = z.object({
  error: z.object({ message: z.string().optional(), code: z.string().optional() }).optional(),
});

/** Options for {@link createStripeSetup}. */
export interface StripeSetupOptions {
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
  /** Permit a non-https base URL override (local dev / mock only — documented leaky-endpoint opt-out). */
  allowInsecure?: boolean;
}

/** Map Stripe's SetupIntent status to the port's normalized status; throw on a canceled/dead one. */
function normalizeStatus(status: string): SetupIntentState['status'] {
  switch (status) {
    case 'succeeded':
      return 'succeeded';
    case 'processing':
      return 'processing';
    case 'requires_action':
    case 'requires_confirmation':
    case 'requires_payment_method':
      return 'requires_action';
    default:
      // canceled / unknown ⇒ the payment method was not saved.
      throw new Error(`stripe setup intent not completed (status: ${status})`);
  }
}

/**
 * Create a {@link PaymentSetup} backed by **Stripe**, over its REST API (no SDK dependency; injectable
 * `fetch`, matching {@link import('./stripe-gateway.js').createStripeGateway}). Onboards a brand-new
 * signup: create a Customer, open a SetupIntent (the browser confirms it with Stripe.js — card data
 * never touches this server), and read the intent back to verify a payment method was actually saved
 * before provisioning.
 *
 * Stripe is an untrusted, unreliable upstream (`topic-api-consumption`): every call is timeout-bound,
 * the response is schema-validated, the caller's idempotency key rides the `Idempotency-Key` header so
 * a retry never duplicates a customer/intent, and a non-2xx throws with Stripe's message (no card data
 * is ever returned or logged — only references). The secret key is never logged.
 *
 * @param options - Stripe secret key + optional base URL / timeout / fetch.
 * @returns A Stripe-backed payment-setup port.
 */
export function createStripeSetup(options: StripeSetupOptions): PaymentSetup {
  const baseUrl = (options.baseUrl ?? 'https://api.stripe.com').replace(/\/+$/, '');
  // The default is https; a custom baseUrl (mock/proxy) must stay TLS too — payment-onboarding traffic.
  assertHttpsUrl(baseUrl, 'STRIPE_API_BASE_URL', options.allowInsecure);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const doFetch = options.fetchImpl ?? globalThis.fetch;

  const request = async (
    method: 'GET' | 'POST',
    path: string,
    op: string,
    body?: URLSearchParams,
    idempotencyKey?: string,
  ): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${options.secretKey}`,
          ...(body !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          // Stripe de-duplicates retried POSTs sharing this key — no duplicate customer/intent.
          ...(idempotencyKey !== undefined ? { 'idempotency-key': idempotencyKey } : {}),
        },
        ...(body !== undefined ? { body } : {}),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const payload: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const parsed = StripeErrorSchema.safeParse(payload);
      const msg = parsed.success ? parsed.data.error?.message : undefined;
      throw new Error(`stripe ${op} failed (${res.status}): ${msg ?? 'unknown error'}`);
    }
    return payload;
  };

  const withMetadata = (
    body: URLSearchParams,
    metadata?: Record<string, string>,
  ): URLSearchParams => {
    for (const [k, v] of Object.entries(metadata ?? {})) body.set(`metadata[${k}]`, v);
    return body;
  };

  return {
    provider: 'stripe',
    async createCustomer(req: CreateCustomerRequest): Promise<CreateCustomerResult> {
      const body = withMetadata(new URLSearchParams({ email: req.email }), req.metadata);
      const customer = CustomerSchema.parse(
        await request('POST', '/v1/customers', 'create customer', body, req.idempotencyKey),
      );
      return { customerRef: customer.id, provider: 'stripe' };
    },
    async createSetupIntent(req: CreateSetupIntentRequest): Promise<CreateSetupIntentResult> {
      // off_session usage: the saved method is charged later, unattended, by the billing run.
      const body = withMetadata(
        new URLSearchParams({ customer: req.customerRef, usage: 'off_session' }),
        req.metadata,
      );
      const intent = SetupIntentSchema.parse(
        await request('POST', '/v1/setup_intents', 'create setup intent', body, req.idempotencyKey),
      );
      return {
        setupIntentId: intent.id,
        clientSecret: intent.client_secret,
        provider: 'stripe',
      };
    },
    async getSetupIntent(setupIntentId: string): Promise<SetupIntentState> {
      const intent = SetupIntentStateSchema.parse(
        await request(
          'GET',
          `/v1/setup_intents/${encodeURIComponent(setupIntentId)}`,
          'get setup intent',
        ),
      );
      return {
        status: normalizeStatus(intent.status),
        customerRef: intent.customer,
        ...(intent.payment_method ? { paymentMethodRef: intent.payment_method } : {}),
        provider: 'stripe',
      };
    },
    async setDefaultPaymentMethod(customerRef: string, paymentMethodRef: string): Promise<void> {
      // Update the customer's invoice_settings.default_payment_method — the value the off_session
      // charge path reads (the gateway sends `customer` + `off_session` with no explicit method).
      const body = new URLSearchParams({
        'invoice_settings[default_payment_method]': paymentMethodRef,
      });
      // Idempotency-keyed by (customer, method): a retry of the same set-default is a safe no-op.
      await request(
        'POST',
        `/v1/customers/${encodeURIComponent(customerRef)}`,
        'set default payment method',
        body,
        `set-default-pm:${customerRef}:${paymentMethodRef}`,
      );
    },
  };
}
