import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { PaymentEvent, PaymentWebhookVerifier } from '../../ports/payment-webhook.js';

/** The Stripe event envelope fields we depend on. */
const StripeEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  created: z.number().optional(),
  data: z.object({
    object: z
      .object({
        id: z.string().optional(),
        amount: z.number().optional(),
        currency: z.string().optional(),
        metadata: z.record(z.string(), z.string()).optional(),
      })
      .passthrough(),
  }),
});

/** Options for {@link createStripeWebhookVerifier}. */
export interface StripeWebhookVerifierOptions {
  /**
   * Stripe **webhook signing secret** (`whsec_…`) — distinct from the API key; a secret from the
   * secret manager / env, never committed or logged (`workflow-secrets`).
   */
  signingSecret: string;
  /** Max age (seconds) of the signed timestamp before it's rejected (replay defence). Defaults to 300. */
  toleranceSec?: number;
  /** Injectable clock (ms). Defaults to `Date.now`. */
  now?: () => number;
}

/** Map a Stripe event type to the normalized type. */
function normalizeType(stripeType: string): PaymentEvent['type'] {
  switch (stripeType) {
    case 'payment_intent.succeeded':
      return 'charge.succeeded';
    case 'payment_intent.payment_failed':
      return 'charge.failed';
    case 'charge.refunded':
      return 'charge.refunded';
    default:
      return 'unknown';
  }
}

/**
 * Create a {@link PaymentWebhookVerifier} for **Stripe** webhooks. Verifies the `Stripe-Signature`
 * header against the raw body per Stripe's scheme (HMAC-SHA256 over `"{t}.{rawBody}"`, **constant-time**
 * compare against the `v1` signatures), rejects a timestamp older than the tolerance (**replay
 * defence**), then parses + normalizes the event. Treats the payload as untrusted (schema-validated).
 * Swap this for another PSP's verifier behind the same port without touching the ingestion endpoint.
 *
 * @param options - Webhook signing secret + optional tolerance / clock.
 * @returns A Stripe webhook verifier.
 */
export function createStripeWebhookVerifier(
  options: StripeWebhookVerifierOptions,
): PaymentWebhookVerifier {
  const toleranceSec = options.toleranceSec ?? 300;
  const now = options.now ?? ((): number => Date.now());

  return {
    provider: 'stripe',
    verify(rawBody: string, signature: string): PaymentEvent {
      // Parse `t=...,v1=...[,v1=...]` (ignore other schemes/keys).
      let timestamp: number | undefined;
      const v1: string[] = [];
      for (const part of signature.split(',')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        const key = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim();
        if (key === 't') timestamp = Number(value);
        else if (key === 'v1') v1.push(value);
      }
      if (timestamp === undefined || !Number.isFinite(timestamp) || v1.length === 0) {
        throw new Error('malformed Stripe-Signature header');
      }

      // Replay defence: reject a timestamp outside the tolerance window.
      if (Math.abs(now() / 1000 - timestamp) > toleranceSec) {
        throw new Error('webhook timestamp outside tolerance');
      }

      // Recompute the HMAC over "{t}.{rawBody}" and constant-time compare against a presented v1.
      const expected = createHmac('sha256', options.signingSecret)
        .update(`${timestamp}.${rawBody}`)
        .digest('hex');
      const expectedBuf = Buffer.from(expected);
      const match = v1.some((sig) => {
        const got = Buffer.from(sig);
        return got.length === expectedBuf.length && timingSafeEqual(got, expectedBuf);
      });
      if (!match) throw new Error('webhook signature mismatch');

      // Verified — now parse the (untrusted) payload.
      const event = StripeEventSchema.parse(JSON.parse(rawBody));
      const obj = event.data.object;
      return {
        id: event.id,
        type: normalizeType(event.type),
        provider: 'stripe',
        rawType: event.type,
        occurredAt: new Date((event.created ?? Math.floor(now() / 1000)) * 1000).toISOString(),
        ...(obj.metadata?.['tenant_id'] !== undefined
          ? { tenantRef: obj.metadata['tenant_id'] }
          : {}),
        ...(obj.id !== undefined ? { chargeId: obj.id } : {}),
        ...(obj.amount !== undefined ? { amountMinor: obj.amount } : {}),
        ...(obj.currency !== undefined ? { currency: obj.currency } : {}),
      };
    },
  };
}
