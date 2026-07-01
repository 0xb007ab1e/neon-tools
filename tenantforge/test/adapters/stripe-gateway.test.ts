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

  it('refunds a charge fully: posts the payment_intent + idempotency key, maps the refunded amount', async () => {
    const { impl, calls } = fakeFetch(200, { id: 're_1', status: 'succeeded', amount: 1234 });
    const gw = createStripeGateway({ secretKey: 'sk_test_x', fetchImpl: impl });
    const result = await gw.refund({
      chargeId: 'pi_1',
      currency: 'usd',
      idempotencyKey: 'refund-key-1',
      reason: 'overcharge',
      metadata: { tenant_id: 't1' },
    });
    expect(result).toEqual({
      id: 're_1',
      status: 'succeeded',
      amountMinor: 1234, // resolved from Stripe's echoed amount (full refund)
      currency: 'usd',
      provider: 'stripe',
    });
    const call = calls[0]!;
    expect(call.url).toBe('https://api.stripe.com/v1/refunds');
    const headers = call.init.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe('refund-key-1');
    const body = (call.init.body as URLSearchParams).toString();
    expect(body).toContain('payment_intent=pi_1');
    expect(body).not.toContain('amount='); // full refund → no amount
    expect(body).toContain('metadata%5Btenant_id%5D=t1');
    expect(body).toContain('metadata%5Breason%5D=overcharge'); // free-text reason → metadata, not Stripe enum
  });

  it('refunds partially: includes the amount and maps pending', async () => {
    const { impl, calls } = fakeFetch(200, { id: 're_2', status: 'pending', amount: 500 });
    const gw = createStripeGateway({ secretKey: 'sk', fetchImpl: impl });
    const result = await gw.refund({
      chargeId: 'pi_2',
      amountMinor: 500,
      currency: 'usd',
      idempotencyKey: 'refund-key-2',
    });
    expect(result.status).toBe('pending');
    expect(result.amountMinor).toBe(500);
    expect((calls[0]!.init.body as URLSearchParams).toString()).toContain('amount=500');
  });

  it('throws when the refund did not complete (e.g. failed)', async () => {
    const gw = createStripeGateway({
      secretKey: 'sk',
      fetchImpl: fakeFetch(200, { id: 're_3', status: 'failed' }).impl,
    });
    await expect(
      gw.refund({ chargeId: 'pi_3', currency: 'usd', idempotencyKey: 'k' }),
    ).rejects.toThrow(/refund not completed/);
  });

  it("throws Stripe's message on a non-2xx refund (e.g. already refunded)", async () => {
    const gw = createStripeGateway({
      secretKey: 'sk',
      fetchImpl: fakeFetch(400, { error: { message: 'Charge has already been refunded.' } }).impl,
    });
    await expect(
      gw.refund({ chargeId: 'pi_4', currency: 'usd', idempotencyKey: 'k' }),
    ).rejects.toThrow(/already been refunded/);
  });
});

describe('createStripeGateway transient retries (gap #9)', () => {
  /**
   * A fake fetch driven by a scripted sequence: a `number` yields an HTTP response with that status,
   * `'throw'` simulates a network error / timeout. Records every call so we can assert the retry
   * count + that the SAME idempotency key is reused (Stripe de-dupes → no double-charge).
   */
  function scriptedFetch(
    steps: (number | 'throw')[],
    okBody: unknown = { id: 'pi_r', status: 'succeeded' },
  ) {
    const calls: { url: string; init: RequestInit }[] = [];
    let i = 0;
    const impl = ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      const step = steps[Math.min(i, steps.length - 1)]!;
      i += 1;
      if (step === 'throw') return Promise.reject(new Error('network down'));
      const body =
        step >= 200 && step < 300 ? okBody : { error: { message: `stripe says ${step}` } };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: step,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  // Instant, deterministic backoff for the suite (no real waiting; jitter value is irrelevant here).
  const noSleep = (): Promise<void> => Promise.resolve();

  it('retries a 429 then succeeds, reusing the same idempotency key on every attempt', async () => {
    const { impl, calls } = scriptedFetch([429, 200]);
    const gw = createStripeGateway({ secretKey: 'sk', fetchImpl: impl, sleep: noSleep });
    const result = await gw.charge(req);
    expect(result.status).toBe('succeeded');
    expect(calls.length).toBe(2);
    const keys = calls.map((c) => (c.init.headers as Record<string, string>)['idempotency-key']);
    expect(keys).toEqual(['idem-key-1', 'idem-key-1']); // same key → Stripe de-dupes, no double-charge
  });

  it('retries a 5xx then succeeds', async () => {
    const { impl, calls } = scriptedFetch([503, 200]);
    const gw = createStripeGateway({ secretKey: 'sk', fetchImpl: impl, sleep: noSleep });
    expect((await gw.charge(req)).status).toBe('succeeded');
    expect(calls.length).toBe(2);
  });

  it('retries a network error then succeeds', async () => {
    const { impl, calls } = scriptedFetch(['throw', 200]);
    const gw = createStripeGateway({ secretKey: 'sk', fetchImpl: impl, sleep: noSleep });
    expect((await gw.charge(req)).status).toBe('succeeded');
    expect(calls.length).toBe(2);
  });

  it('gives up after maxAttempts on a persistent 5xx and throws the last error', async () => {
    const { impl, calls } = scriptedFetch([500]);
    const gw = createStripeGateway({
      secretKey: 'sk',
      fetchImpl: impl,
      sleep: noSleep,
      maxAttempts: 3,
    });
    await expect(gw.charge(req)).rejects.toThrow(/stripe charge failed \(500\)/);
    expect(calls.length).toBe(3);
  });

  it('gives up after maxAttempts on a persistent network error', async () => {
    const { impl, calls } = scriptedFetch(['throw']);
    const gw = createStripeGateway({
      secretKey: 'sk',
      fetchImpl: impl,
      sleep: noSleep,
      maxAttempts: 2,
    });
    await expect(gw.charge(req)).rejects.toThrow(/stripe charge request failed/);
    expect(calls.length).toBe(2);
  });

  it('fails fast on a 4xx card decline (402) — no retry', async () => {
    const { impl, calls } = scriptedFetch([402]);
    const gw = createStripeGateway({
      secretKey: 'sk',
      fetchImpl: impl,
      sleep: noSleep,
      maxAttempts: 3,
    });
    await expect(gw.charge(req)).rejects.toThrow(/stripe charge failed \(402\)/);
    expect(calls.length).toBe(1); // terminal — not retried
  });
});
