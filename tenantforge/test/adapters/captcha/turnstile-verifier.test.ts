import { describe, expect, it } from 'vitest';
import { createTurnstileVerifier } from '../../../src/adapters/captcha/turnstile-verifier.js';
import { createNoopCaptchaVerifier } from '../../../src/adapters/captcha/noop-verifier.js';

/** A fake fetch returning a canned siteverify response (or throwing to simulate a transport error). */
function fakeFetch(opts: { status?: number; body?: unknown; throws?: boolean }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (opts.throws === true) return Promise.reject(new Error('network down'));
    return Promise.resolve(
      new Response(JSON.stringify(opts.body ?? {}), {
        status: opts.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('createTurnstileVerifier', () => {
  it('passes when the provider reports success, sending secret + response (+ remoteip)', async () => {
    const { impl, calls } = fakeFetch({ body: { success: true } });
    const v = createTurnstileVerifier({ secretKey: 'sk', fetchImpl: impl });
    expect(await v.verify('tok', '203.0.113.7')).toEqual({ success: true, provider: 'turnstile' });
    const body = (calls[0]!.init.body as URLSearchParams).toString();
    expect(body).toContain('secret=sk');
    expect(body).toContain('response=tok');
    expect(body).toContain('remoteip=203.0.113.7');
  });

  it('fails (not throws) when the provider reports failure, surfacing error codes', async () => {
    const { impl } = fakeFetch({
      body: { success: false, 'error-codes': ['invalid-input-response'] },
    });
    const v = createTurnstileVerifier({ secretKey: 'sk', fetchImpl: impl });
    expect(await v.verify('tok')).toEqual({
      success: false,
      provider: 'turnstile',
      errorCodes: ['invalid-input-response'],
    });
  });

  it('rejects an empty token without calling the provider', async () => {
    const { impl, calls } = fakeFetch({ body: { success: true } });
    const v = createTurnstileVerifier({ secretKey: 'sk', fetchImpl: impl });
    const res = await v.verify('');
    expect(res.success).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('FAILS CLOSED on a transport error (no open gate on a captcha outage)', async () => {
    const { impl } = fakeFetch({ throws: true });
    const v = createTurnstileVerifier({ secretKey: 'sk', fetchImpl: impl });
    expect(await v.verify('tok')).toEqual({
      success: false,
      provider: 'turnstile',
      errorCodes: ['transport-error'],
    });
  });

  it('FAILS CLOSED on a non-2xx', async () => {
    const { impl } = fakeFetch({ status: 500, body: {} });
    const v = createTurnstileVerifier({ secretKey: 'sk', fetchImpl: impl });
    expect((await v.verify('tok')).success).toBe(false);
  });
});

describe('createNoopCaptchaVerifier', () => {
  it('always passes (dev/test only)', async () => {
    const v = createNoopCaptchaVerifier();
    expect(await v.verify('anything')).toEqual({ success: true, provider: 'noop' });
  });
});
