import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { TenantEvent } from '../../src/core/observability.js';
import { createWebhookEventSink } from '../../src/adapters/webhook-event-sink.js';

function ev(overrides: Partial<TenantEvent> = {}): TenantEvent {
  return {
    event: 'tenant.provisioned',
    at: '2026-06-18T00:00:00.000Z',
    outcome: 'ok',
    ...overrides,
  };
}

const base = {
  url: 'https://hooks.example.com/tf',
  secret: 's3cr3t',
  now: (): number => 1000,
  sleep: (): Promise<void> => Promise.resolve(),
  jitter: (): number => 0,
};

const ok = (): Response => new Response('', { status: 200 });

describe('createWebhookEventSink — construction', () => {
  it('throws on a non-https url by default', () => {
    expect(() => createWebhookEventSink({ ...base, url: 'http://insecure/x' })).toThrow(
      /must be https/,
    );
  });

  it('allows a non-https url when allowInsecureUrl is set', () => {
    expect(() =>
      createWebhookEventSink({ ...base, url: 'http://localhost:9/x', allowInsecureUrl: true }),
    ).not.toThrow();
  });
});

describe('createWebhookEventSink — deliver', () => {
  it('signs the body and POSTs (delivered on 2xx)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok());
    const sink = createWebhookEventSink({
      ...base,
      fetchImpl,
    });
    const event = ev();
    const out = await sink.deliver(event);

    expect(out).toEqual({ delivered: true, attempts: 1, status: 200 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(base.url);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error'); // SSRF: never follow redirects
    const body = init.body as string;
    expect(JSON.parse(body)).toEqual(event);
    const expectedSig = createHmac('sha256', base.secret).update(`1000.${body}`).digest('hex');
    expect(init.headers['x-tenantforge-signature']).toBe(`sha256=${expectedSig}`);
    expect(init.headers['x-tenantforge-timestamp']).toBe('1000');
  });

  it('skips events not on the eventTypes allow-list', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok());
    const sink = createWebhookEventSink({
      ...base,
      eventTypes: ['tenant.erased'],
      fetchImpl,
    });
    expect(await sink.deliver(ev({ event: 'tenant.provisioned' }))).toEqual({
      delivered: false,
      attempts: 0,
      skipped: true,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('retries with backoff on a non-2xx, then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(ok());
    const sleep = vi.fn().mockResolvedValue(undefined);
    const sink = createWebhookEventSink({
      ...base,
      sleep,
      fetchImpl,
    });
    const out = await sink.deliver(ev());
    expect(out).toEqual({ delivered: true, attempts: 2, status: 200 });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(200); // backoff 200 * 2^0 * (1 + 0 jitter)
  });

  it('retries when fetch throws, then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(ok());
    const sink = createWebhookEventSink({
      ...base,
      fetchImpl,
    });
    expect((await sink.deliver(ev())).delivered).toBe(true);
  });

  it('dead-letters via onError after exhausting attempts (non-2xx)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
    const onError = vi.fn();
    const sink = createWebhookEventSink({
      ...base,
      maxAttempts: 2,
      onError,
      fetchImpl,
    });
    const out = await sink.deliver(ev());
    expect(out).toEqual({ delivered: false, attempts: 2, status: 500 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'tenant.provisioned' }),
      'HTTP 500',
    );
  });

  it('exhausts without an onError hook (no throw, no status when fetch always throws)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('boom'));
    const sink = createWebhookEventSink({
      ...base,
      maxAttempts: 2,
      fetchImpl,
    });
    const out = await sink.deliver(ev());
    expect(out).toEqual({ delivered: false, attempts: 2 }); // no status — never got a response
  });

  it('stringifies a non-Error throw for the dead-letter reason', async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- testing a non-Error throw
    const fetchImpl = vi.fn().mockImplementation(() => Promise.reject('weird'));
    const onError = vi.fn();
    const sink = createWebhookEventSink({ ...base, maxAttempts: 1, onError, fetchImpl });
    await sink.deliver(ev());
    expect(onError).toHaveBeenCalledWith(expect.anything(), 'weird');
  });

  it('uses real fetch / clock / sleep / jitter defaults', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(ok());
    try {
      // No now/sleep/jitter/fetchImpl overrides → exercises the default implementations.
      const sink = createWebhookEventSink({ url: base.url, secret: base.secret, backoffMs: 1 });
      const out = await sink.deliver(ev());
      expect(out.delivered).toBe(true);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('aborts an attempt that exceeds the timeout', async () => {
    const hangFetch = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch;
    const onError = vi.fn();
    const sink = createWebhookEventSink({
      ...base,
      timeoutMs: 0,
      maxAttempts: 1,
      onError,
      fetchImpl: hangFetch,
    });
    const out = await sink.deliver(ev());
    expect(out.delivered).toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.anything(), 'aborted');
  });
});

describe('createWebhookEventSink — emit', () => {
  it('fire-and-forgets a delivery (non-blocking, never throws)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok());
    const sink = createWebhookEventSink({
      ...base,
      fetchImpl,
    });
    expect(() => sink.emit(ev())).not.toThrow();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
  });
});
