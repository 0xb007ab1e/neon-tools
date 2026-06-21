import { describe, expect, it } from 'vitest';
import { createLogNotifier } from '../../src/adapters/notify/log-notifier.js';
import { createHttpNotifier } from '../../src/adapters/notify/http-notifier.js';
import { createSesNotifier, type SesClientLike } from '../../src/adapters/notify/ses-notifier.js';
import {
  createSmtpNotifier,
  type SmtpTransportLike,
} from '../../src/adapters/notify/smtp-notifier.js';
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

describe('createSesNotifier', () => {
  it('sends via the injected SES client and maps the MessageId', async () => {
    const calls: unknown[] = [];
    const client: SesClientLike = {
      sendEmail: (i) => {
        calls.push(i);
        return Promise.resolve({ MessageId: 'ses-msg-1' });
      },
    };
    const result = await createSesNotifier({ client, from: 'billing@you.example' }).notify(note);
    expect(result).toEqual({ id: 'ses-msg-1', provider: 'ses', status: 'sent' });
    expect(calls[0]).toEqual({
      FromEmailAddress: 'billing@you.example',
      Destination: { ToAddresses: ['billing@acme.example'] },
      Content: {
        Simple: {
          Subject: { Data: note.subject },
          Body: { Text: { Data: note.body } },
        },
      },
    });
  });

  it('falls back to the idempotency key when SES returns no MessageId', async () => {
    const client: SesClientLike = { sendEmail: () => Promise.resolve({}) };
    const result = await createSesNotifier({ client, from: 'b@you.example' }).notify(note);
    expect(result.id).toBe(note.idempotencyKey);
  });

  it('propagates a client error (the caller audits + isolates it)', async () => {
    const client: SesClientLike = { sendEmail: () => Promise.reject(new Error('SES throttled')) };
    await expect(createSesNotifier({ client, from: 'b@you.example' }).notify(note)).rejects.toThrow(
      /SES throttled/,
    );
  });
});

describe('createSmtpNotifier', () => {
  it('sends via the injected transport and maps the messageId', async () => {
    const calls: unknown[] = [];
    const transport: SmtpTransportLike = {
      sendMail: (m) => {
        calls.push(m);
        return Promise.resolve({ messageId: 'smtp-1' });
      },
    };
    const result = await createSmtpNotifier({ transport, from: 'billing@you.example' }).notify(
      note,
    );
    expect(result).toEqual({ id: 'smtp-1', provider: 'smtp', status: 'sent' });
    expect(calls[0]).toEqual({
      from: 'billing@you.example',
      to: 'billing@acme.example',
      subject: note.subject,
      text: note.body,
    });
  });

  it('propagates a transport error', async () => {
    const transport: SmtpTransportLike = {
      sendMail: () => Promise.reject(new Error('smtp connect failed')),
    };
    await expect(
      createSmtpNotifier({ transport, from: 'b@you.example' }).notify(note),
    ).rejects.toThrow(/smtp connect failed/);
  });
});
