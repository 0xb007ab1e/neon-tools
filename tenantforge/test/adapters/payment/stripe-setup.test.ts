import { describe, expect, it } from 'vitest';
import { createStripeSetup } from '../../../src/adapters/payment/stripe-setup.js';

/** A fake fetch that records requests and returns canned responses (one per call, in order). */
function fakeFetch(responses: { status: number; body: unknown }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let i = 0;
  const impl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return Promise.resolve(
      new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('createStripeSetup', () => {
  it('creates a customer with email + idempotency key', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { id: 'cus_1' } }]);
    const setup = createStripeSetup({ secretKey: 'sk_test_x', fetchImpl: impl });
    const res = await setup.createCustomer({
      email: 'new@example.com',
      idempotencyKey: 'idem-1',
      metadata: { signup_id: 's1' },
    });
    expect(res).toEqual({ customerRef: 'cus_1', provider: 'stripe' });
    const call = calls[0]!;
    expect(call.url).toBe('https://api.stripe.com/v1/customers');
    const headers = call.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer sk_test_x');
    expect(headers['idempotency-key']).toBe('idem-1');
    const body = (call.init.body as URLSearchParams).toString();
    expect(body).toContain('email=new%40example.com');
    expect(body).toContain('metadata%5Bsignup_id%5D=s1');
  });

  it('creates an off-session setup intent and returns the client secret', async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        body: {
          id: 'seti_1',
          status: 'requires_payment_method',
          client_secret: 'seti_1_secret',
          customer: 'cus_1',
        },
      },
    ]);
    const setup = createStripeSetup({ secretKey: 'sk_test_x', fetchImpl: impl });
    const res = await setup.createSetupIntent({ customerRef: 'cus_1', idempotencyKey: 'idem-2' });
    expect(res).toEqual({
      setupIntentId: 'seti_1',
      clientSecret: 'seti_1_secret',
      provider: 'stripe',
    });
    const body = (calls[0]!.init.body as URLSearchParams).toString();
    expect(body).toContain('customer=cus_1');
    expect(body).toContain('usage=off_session');
  });

  it('reads back a succeeded setup intent with the saved payment method (GET, no body)', async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        body: { id: 'seti_1', status: 'succeeded', customer: 'cus_1', payment_method: 'pm_1' },
      },
    ]);
    const setup = createStripeSetup({ secretKey: 'sk_test_x', fetchImpl: impl });
    const res = await setup.getSetupIntent('seti_1');
    expect(res).toEqual({
      status: 'succeeded',
      customerRef: 'cus_1',
      paymentMethodRef: 'pm_1',
      provider: 'stripe',
    });
    expect(calls[0]!.url).toBe('https://api.stripe.com/v1/setup_intents/seti_1');
    expect(calls[0]!.init.method).toBe('GET');
  });

  it('maps in-progress statuses to requires_action and throws on a canceled intent', async () => {
    const mk = (status: string) =>
      createStripeSetup({
        secretKey: 'sk',
        fetchImpl: fakeFetch([{ status: 200, body: { id: 'seti_1', status, customer: 'cus_1' } }])
          .impl,
      });
    expect((await mk('requires_action').getSetupIntent('seti_1')).status).toBe('requires_action');
    expect((await mk('processing').getSetupIntent('seti_1')).status).toBe('processing');
    await expect(mk('canceled').getSetupIntent('seti_1')).rejects.toThrow(/not completed/);
  });

  it('throws with Stripe’s message on a non-2xx', async () => {
    const { impl } = fakeFetch([{ status: 402, body: { error: { message: 'card declined' } } }]);
    const setup = createStripeSetup({ secretKey: 'sk', fetchImpl: impl });
    await expect(setup.createCustomer({ email: 'a@b.com', idempotencyKey: 'k' })).rejects.toThrow(
      /stripe create customer failed \(402\): card declined/,
    );
  });

  it('rejects a non-https base URL unless allowInsecure', () => {
    expect(() => createStripeSetup({ secretKey: 'sk', baseUrl: 'http://insecure' })).toThrow();
    expect(() =>
      createStripeSetup({ secretKey: 'sk', baseUrl: 'http://localhost:1234', allowInsecure: true }),
    ).not.toThrow();
  });
});
