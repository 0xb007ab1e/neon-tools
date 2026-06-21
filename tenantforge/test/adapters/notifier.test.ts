import { describe, expect, it } from 'vitest';
import { createLogNotifier } from '../../src/adapters/notify/log-notifier.js';
import { createHttpNotifier } from '../../src/adapters/notify/http-notifier.js';
import type { Notification } from '../../src/ports/notifier.js';

const note: Notification = {
  to: 'billing@acme.example',
  subject: 'Your receipt for 12.34 USD',
  body: 'Hi acme, ...',
  idempotencyKey: 'tenantforge:receipt:charge:ch_1',
  metadata: { tenant_id: 't-a' },
};

/** A fake fetch that records the request and returns a canned status. */
function fakeFetch(status: number) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response('', { status }));
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('createLogNotifier', () => {
  it('records (queues) the notification without exposing the recipient', async () => {
    const result = await createLogNotifier().notify(note);
    expect(result).toEqual({
      id: 'tenantforge:receipt:charge:ch_1',
      provider: 'log',
      status: 'queued',
    });
    expect(JSON.stringify(result)).not.toContain('acme.example'); // recipient not in the result
  });
});

describe('createHttpNotifier', () => {
  it('POSTs JSON to the https relay with the idempotency-key + HMAC signature, returns sent', async () => {
    const { impl, calls } = fakeFetch(200);
    const n = createHttpNotifier({
      url: 'https://relay.example/send',
      secret: 'shh',
      fetchImpl: impl,
    });
    const result = await n.notify(note);
    expect(result).toEqual({
      id: 'tenantforge:receipt:charge:ch_1',
      provider: 'http',
      status: 'sent',
    });
    const call = calls[0]!;
    expect(call.url).toBe('https://relay.example/send');
    expect(call.init.method).toBe('POST');
    expect(call.init.redirect).toBe('error'); // SSRF defence
    const headers = call.init.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe('tenantforge:receipt:charge:ch_1');
    expect(headers['x-tenantforge-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(JSON.parse(call.init.body as string)).toMatchObject({ to: 'billing@acme.example' });
  });

  it('omits the signature header when no secret is configured', async () => {
    const { impl, calls } = fakeFetch(200);
    const n = createHttpNotifier({ url: 'https://relay.example/send', fetchImpl: impl });
    await n.notify(note);
    expect(
      (calls[0]!.init.headers as Record<string, string>)['x-tenantforge-signature'],
    ).toBeUndefined();
  });

  it('throws on a non-2xx relay response (the caller audits + isolates it)', async () => {
    const n = createHttpNotifier({
      url: 'https://relay.example/send',
      fetchImpl: fakeFetch(500).impl,
    });
    await expect(n.notify(note)).rejects.toThrow(/relay failed \(500\)/);
  });

  it('refuses a non-https relay URL at construction (fail closed)', () => {
    expect(() => createHttpNotifier({ url: 'http://relay.local/send' })).toThrow(/must use TLS/);
    expect(() =>
      createHttpNotifier({ url: 'http://relay.local/send', allowInsecure: true }),
    ).not.toThrow();
  });
});
