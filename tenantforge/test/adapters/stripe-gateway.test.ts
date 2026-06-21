import { describe, expect, it } from 'vitest';
import { createStripeGateway } from '../../src/adapters/payment/stripe-gateway.js';
import type { ChargeRequest } from '../../src/ports/payment-gateway.js';

const req: ChargeRequest = {
  amountMinor: 1234,
  currency: 'usd',
  customerRef: 'cus_123',
  idempotencyKey: 'idem-key-1',
  description: 'TenantForge t1',
  metadata: { tenant_id: 't1' },
};

/** A fake fetch that records the request and returns a canned response. */
function fakeFetch(status: number, jsonBody: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(jsonBody), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('createStripeGateway', () => {
  it('posts a confirmed off-session PaymentIntent with the idempotency key + amount, mapping success', async () => {
    const { impl, calls } = fakeFetch(200, { id: 'pi_1', status: 'succeeded' });
    const gw = createStripeGateway({ secretKey: 'sk_test_x', fetchImpl: impl });
    const result = await gw.charge(req);

    expect(result).toEqual({
      id: 'pi_1',
      status: 'succeeded',
      amountMinor: 1234,
      currency: 'usd',
      provider: 'stripe',
    });
    const call = calls[0]!;
    expect(call.url).toBe('https://api.stripe.com/v1/payment_intents');
    const headers = call.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer sk_test_x');
    expect(headers['idempotency-key']).toBe('idem-key-1');
    const body = (call.init.body as URLSearchParams).toString();
    expect(body).toContain('amount=1234');
    expect(body).toContain('currency=usd');
    expect(body).toContain('customer=cus_123');
    expect(body).toContain('confirm=true');
    expect(body).toContain('off_session=true');
    expect(body).toContain('metadata%5Btenant_id%5D=t1'); // metadata[tenant_id]=t1 (for webhook correlation)
  });

  it('maps processing and requires_action statuses', async () => {
    const proc = createStripeGateway({
      secretKey: 'sk',
      fetchImpl: fakeFetch(200, { id: 'pi_2', status: 'processing' }).impl,
    });
    expect((await proc.charge(req)).status).toBe('processing');
    const act = createStripeGateway({
      secretKey: 'sk',
      fetchImpl: fakeFetch(200, { id: 'pi_3', status: 'requires_action' }).impl,
    });
    expect((await act.charge(req)).status).toBe('requires_action');
  });

  it('throws when the intent did not complete (e.g. requires_payment_method)', async () => {
    const gw = createStripeGateway({
      secretKey: 'sk',
      fetchImpl: fakeFetch(200, { id: 'pi_4', status: 'requires_payment_method' }).impl,
    });
    await expect(gw.charge(req)).rejects.toThrow(/not completed/);
  });

  it("throws Stripe's message on a non-2xx (e.g. a card decline / 402)", async () => {
    const gw = createStripeGateway({
      secretKey: 'sk',
      fetchImpl: fakeFetch(402, {
        error: { message: 'Your card was declined.', code: 'card_declined' },
      }).impl,
    });
    await expect(gw.charge(req)).rejects.toThrow(/Your card was declined/);
  });
});
