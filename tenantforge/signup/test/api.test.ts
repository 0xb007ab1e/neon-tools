import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api';

// Helpers to build fetch Response stand-ins (synthetic data only — no network).
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const noBody = (status: number): Response => new Response(null, { status });

let fetchMock: ReturnType<typeof vi.fn>;

/** A single recorded fetch call: [input, init]. */
type FetchCall = [RequestInfo | URL, RequestInit?];
/** Read a recorded call's [input, init] tuple with a concrete type (avoids unsafe-any). */
const callAt = (i: number): FetchCall => fetchMock.mock.calls[i] as FetchCall;
/** Parse a request body that we set as a JSON string. */
const bodyOf = (init?: RequestInit): Record<string, unknown> =>
  JSON.parse(typeof init?.body === 'string' ? init.body : '') as Record<string, unknown>;
/** URL string of a recorded call's input (string | URL | Request). */
const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('signup api client — request shaping', () => {
  it('GET config: same-origin path, credentials included, no content-type (no body)', async () => {
    fetchMock.mockResolvedValueOnce(json({ publishableKey: 'pk_test', captchaSiteKey: 'cap_1' }));

    const cfg = await api.config();

    expect(cfg).toEqual({ publishableKey: 'pk_test', captchaSiteKey: 'cap_1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = callAt(0);
    expect(urlOf(url)).toBe('/signup/api/config');
    expect(init?.credentials).toBe('include');
    // No body → the content-type header branch is NOT taken.
    const headers = new Headers(init?.headers);
    expect(headers.has('content-type')).toBe(false);
  });

  it('POST start: sets content-type when a body is present and forwards the JSON payload', async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true }));

    const res = await api.start('user@example.com', 'captcha-tok');

    expect(res).toEqual({ ok: true });
    const [url, init] = callAt(0);
    expect(urlOf(url)).toBe('/signup/api/start');
    expect(init?.method).toBe('POST');
    expect(bodyOf(init)).toEqual({
      email: 'user@example.com',
      captchaToken: 'captcha-tok',
    });
    const headers = new Headers(init?.headers);
    // Body present → content-type branch IS taken.
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('verifyEmail: 204 no-body success resolves to void (json() throws → body stays undefined)', async () => {
    fetchMock.mockResolvedValueOnce(noBody(204));

    await expect(api.verifyEmail('123456')).resolves.toBeUndefined();
    const [url, init] = callAt(0);
    expect(urlOf(url)).toBe('/signup/api/verify-email');
    expect(init?.method).toBe('POST');
  });

  it('paymentIntent: POST with no JSON body and returns the setup intent', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ clientSecret: 'cs_1', setupIntentId: 'si_1', publishableKey: 'pk_test' }),
    );

    const res = await api.paymentIntent();

    expect(res).toEqual({ clientSecret: 'cs_1', setupIntentId: 'si_1', publishableKey: 'pk_test' });
    const [url, init] = callAt(0);
    expect(urlOf(url)).toBe('/signup/api/payment-intent');
    expect(init?.method).toBe('POST');
    // No body on payment-intent → content-type header is NOT set.
    expect(new Headers(init?.headers).has('content-type')).toBe(false);
  });

  it('complete: omits undefined optionals, sends only the provided fields', async () => {
    fetchMock.mockResolvedValueOnce(json({ status: 'provisioning' }));

    const res = await api.complete({ slug: 'acme', region: 'aws-us-east-1', planId: 'pro' });

    expect(res).toEqual({ status: 'provisioning' });
    const body = bodyOf(callAt(0)[1]);
    expect(body).toEqual({ slug: 'acme', region: 'aws-us-east-1', planId: 'pro' });
  });

  it('status: GET returns the funnel status with connectionUri', async () => {
    fetchMock.mockResolvedValueOnce(json({ status: 'active', slug: 'acme', connectionUri: 'uri' }));

    const res = await api.status();

    expect(res).toEqual({ status: 'active', slug: 'acme', connectionUri: 'uri' });
    expect(urlOf(callAt(0)[0])).toBe('/signup/api/status');
  });
});

describe('signup api client — error / abuse paths (fail closed)', () => {
  it('non-2xx WITH a server {error} message: throws that exact (already-safe) message', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'email already in use' }, 409));

    await expect(api.start('dupe@example.com', 'tok')).rejects.toThrow('email already in use');
  });

  it('non-2xx with a NON-object body (e.g. a string): falls back to "request failed (status)"', async () => {
    // Body is valid JSON but not an object → the `typeof body === "object"` branch is false.
    fetchMock.mockResolvedValueOnce(json('nope', 400));

    await expect(api.verifyEmail('000000')).rejects.toThrow('request failed (400)');
  });

  it('non-2xx with an object body lacking an "error" key: falls back to status message', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: 'x' }, 403));

    await expect(api.complete({ slug: 'acme' })).rejects.toThrow('request failed (403)');
  });

  it('non-2xx with a NON-JSON body (json() throws → body undefined): falls back to status message', async () => {
    // 500 with no parseable body → catch swallows, body stays undefined, !res.ok hits the fallback.
    fetchMock.mockResolvedValueOnce(noBody(500));

    await expect(api.status()).rejects.toThrow('request failed (500)');
  });

  it('non-2xx with an explicit null JSON body: does not crash on the null-guard, uses fallback', async () => {
    // body === null must not throw on `'error' in body`; the `body !== null` guard covers it.
    fetchMock.mockResolvedValueOnce(json(null, 422));

    await expect(api.verifyEmail('1')).rejects.toThrow('request failed (422)');
  });

  it('network failure (fetch rejects): the rejection propagates to the caller', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(api.config()).rejects.toThrow('Failed to fetch');
  });
});
