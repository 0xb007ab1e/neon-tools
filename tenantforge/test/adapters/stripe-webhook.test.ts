import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createStripeWebhookVerifier } from '../../src/adapters/payment/stripe-webhook.js';

const SECRET = 'whsec_test';
const NOW_MS = 1_782_000_000_000; // fixed clock
const now = (): number => NOW_MS;

/** Build a valid `Stripe-Signature` header for a body at a given timestamp (seconds). */
function sign(body: string, tsSec: number, secret = SECRET): string {
  const v1 = createHmac('sha256', secret).update(`${tsSec}.${body}`).digest('hex');
  return `t=${tsSec},v1=${v1}`;
}

const event = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    id: 'evt_1',
    type: 'payment_intent.succeeded',
    created: Math.floor(NOW_MS / 1000),
    data: {
      object: { id: 'pi_1', amount: 1234, currency: 'usd', metadata: { tenant_id: 't-42' } },
    },
    ...over,
  });

describe('createStripeWebhookVerifier', () => {
  const v = createStripeWebhookVerifier({ signingSecret: SECRET, now });

  it('verifies a valid signature and normalizes the event', () => {
    const body = event();
    const result = v.verify(body, sign(body, Math.floor(NOW_MS / 1000)));
    expect(result).toEqual({
      id: 'evt_1',
      type: 'charge.succeeded',
      provider: 'stripe',
      rawType: 'payment_intent.succeeded',
      occurredAt: new Date(Math.floor(NOW_MS / 1000) * 1000).toISOString(),
      tenantRef: 't-42',
      chargeId: 'pi_1',
      amountMinor: 1234,
      currency: 'usd',
    });
  });

  it('maps failed + refund + unknown types', () => {
    const ts = Math.floor(NOW_MS / 1000);
    const failed = event({ type: 'payment_intent.payment_failed' });
    expect(v.verify(failed, sign(failed, ts)).type).toBe('charge.failed');
    const refund = event({ type: 'charge.refunded' });
    expect(v.verify(refund, sign(refund, ts)).type).toBe('charge.refunded');
    const other = event({ type: 'customer.created' });
    expect(v.verify(other, sign(other, ts)).type).toBe('unknown');
  });

  it('rejects a bad signature (wrong secret)', () => {
    const body = event();
    const bad = sign(body, Math.floor(NOW_MS / 1000), 'whsec_wrong');
    expect(() => v.verify(body, bad)).toThrow(/signature mismatch/);
  });

  it('rejects a tampered body (signature no longer matches)', () => {
    const body = event();
    const sig = sign(body, Math.floor(NOW_MS / 1000));
    expect(() => v.verify(body.replace('1234', '9999'), sig)).toThrow(/signature mismatch/);
  });

  it('rejects a stale timestamp (replay defence)', () => {
    const old = Math.floor(NOW_MS / 1000) - 600; // 10 min ago, tolerance 300s
    const body = event();
    expect(() => v.verify(body, sign(body, old))).toThrow(/outside tolerance/);
  });

  it('rejects a malformed signature header', () => {
    expect(() => v.verify(event(), 'not-a-sig-header')).toThrow(/malformed/);
  });
});
