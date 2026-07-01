import { describe, expect, it } from 'vitest';
import { createSignup } from '../../src/app/signup.js';
import type { TenantForge } from '../../src/app/lib.js';

const NOW = 1_782_000_000_000;

/** A fake TenantForge exposing just the signup methods, recording calls + driven by knobs. */
function fakeTf(knobs: { captchaFails?: boolean } = {}) {
  const calls = { start: [] as unknown[], verify: [] as unknown[], complete: [] as unknown[] };
  const tf = {
    startSignup: (input: unknown) => {
      calls.start.push(input);
      if (knobs.captchaFails === true)
        return Promise.reject(new Error('captcha verification failed'));
      return Promise.resolve({ signupId: 'sid-1' });
    },
    verifyEmail: (_id: string, code: string) => {
      calls.verify.push(code);
      return code === '123456'
        ? Promise.resolve()
        : Promise.reject(new Error('invalid verification code'));
    },
    createPaymentSetup: () => Promise.resolve({ clientSecret: 'cs_1', setupIntentId: 'seti_1' }),
    completeSignup: (_id: string, input: { slug: string }) => {
      calls.complete.push(input);
      return input.slug === 'taken'
        ? Promise.reject(new Error('slug unavailable'))
        : Promise.resolve({ status: 'provisioning' as const, slug: input.slug });
    },
    signupStatus: () =>
      Promise.resolve({ status: 'active' as const, slug: 'acme', connectionUri: 'postgresql://x' }),
  } as unknown as TenantForge;
  return { tf, calls };
}

function build(knobs: { captchaFails?: boolean } = {}) {
  const { tf, calls } = fakeTf(knobs);
  const app = createSignup({
    tf,
    sessionSecret: 'signup-session-secret-0123456789ab',
    publishableKey: 'pk_test',
    captchaSiteKey: 'site_test',
    now: () => NOW,
  });
  return { app, calls };
}

const json = (body: unknown, cookie?: string): RequestInit => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-forwarded-for': '203.0.113.9',
    ...(cookie !== undefined ? { cookie } : {}),
  },
  body: JSON.stringify(body),
});

/** Pull the `tf_signup=…` cookie pair out of a Set-Cookie header. */
function cookieFrom(res: Response): string {
  const sc = res.headers.get('set-cookie') ?? '';
  return /(tf_signup=[^;]+)/.exec(sc)![1]!;
}

describe('createSignup HTTP sub-app', () => {
  it('exposes only the public keys at /api/config', async () => {
    const { app } = build();
    const res = await app.request('/api/config');
    expect(await res.json()).toEqual({ publishableKey: 'pk_test', captchaSiteKey: 'site_test' });
  });

  it('start → sets a Secure HttpOnly signup-session cookie and calls the facade', async () => {
    const { app, calls } = build();
    const res = await app.request('/api/start', json({ email: 'a@b.com', captchaToken: 'tok' }));
    expect(res.status).toBe(200);
    const sc = res.headers.get('set-cookie') ?? '';
    expect(sc).toMatch(/tf_signup=/);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/Secure/i);
    expect(sc).toMatch(/SameSite=Strict/i);
    expect(calls.start[0]).toMatchObject({
      email: 'a@b.com',
      captchaToken: 'tok',
      remoteIp: '203.0.113.9',
    });
  });

  it('rejects an invalid start body (400) and a failed captcha (400)', async () => {
    expect((await build().app.request('/api/start', json({ email: 'not-an-email' }))).status).toBe(
      400,
    );
    const fail = build({ captchaFails: true });
    const res = await fail.app.request('/api/start', json({ email: 'a@b.com', captchaToken: 't' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/captcha/);
  });

  it('requires a session for the protected steps (401 without the cookie)', async () => {
    const { app } = build();
    expect((await app.request('/api/verify-email', json({ code: '123456' }))).status).toBe(401);
    expect((await app.request('/api/payment-intent', { method: 'POST' })).status).toBe(401);
    expect((await app.request('/api/status')).status).toBe(401);
  });

  it('rejects a tampered session cookie (401)', async () => {
    const { app } = build();
    const res = await app.request('/api/status', {
      headers: { cookie: 'tf_signup=forged.signature' },
    });
    expect(res.status).toBe(401);
  });

  it('verify-email: 204 on the right code, 400 on a wrong one', async () => {
    const { app } = build();
    const cookie = cookieFrom(
      await app.request('/api/start', json({ email: 'a@b.com', captchaToken: 't' })),
    );
    expect((await app.request('/api/verify-email', json({ code: '000000' }, cookie))).status).toBe(
      400,
    );
    expect((await app.request('/api/verify-email', json({ code: '123456' }, cookie))).status).toBe(
      204,
    );
  });

  it('payment-intent returns the client secret + publishable key', async () => {
    const { app } = build();
    const cookie = cookieFrom(
      await app.request('/api/start', json({ email: 'a@b.com', captchaToken: 't' })),
    );
    const res = await app.request('/api/payment-intent', { method: 'POST', headers: { cookie } });
    expect(await res.json()).toEqual({
      clientSecret: 'cs_1',
      setupIntentId: 'seti_1',
      publishableKey: 'pk_test',
    });
  });

  it('complete: 200 provisioning, and 409 for an unavailable slug', async () => {
    const { app } = build();
    const cookie = cookieFrom(
      await app.request('/api/start', json({ email: 'a@b.com', captchaToken: 't' })),
    );
    const ok = await app.request('/api/complete', json({ slug: 'acme-co' }, cookie));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: 'provisioning', slug: 'acme-co' });
    const taken = await app.request('/api/complete', json({ slug: 'taken' }, cookie));
    expect(taken.status).toBe(409);
  });

  it('rate-limits start by IP (429 after the cap, with Retry-After)', async () => {
    const { app } = build();
    let last: Response | undefined;
    for (let i = 0; i < 6; i++) {
      last = await app.request('/api/start', json({ email: 'a@b.com', captchaToken: 't' }));
    }
    expect(last!.status).toBe(429);
    expect(last!.headers.get('retry-after')).not.toBeNull();
  });
});
