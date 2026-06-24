import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { TenantForge } from './lib.js';
import type { RateLimitStore } from '../ports/rate-limit-store.js';
import { createInMemoryRateLimitStore } from '../adapters/rate-limit-store.js';

/** Signup-session cookie name (scoped to the signup path). */
const COOKIE = 'tf_signup';
/** Default signup-session lifetime: 30 minutes (the flow is short). */
const DEFAULT_TTL_MS = 30 * 60 * 1000;
/** Signup request bodies are tiny — cap hard. */
const MAX_BODY = 8 * 1024;

/** Options for {@link createSignup}. */
export interface SignupOptions {
  /** The TenantForge service backing the signup flow. */
  tf: TenantForge;
  /** HMAC key signing the signup-session cookie (a secret; required). */
  sessionSecret: string;
  /** Stripe **publishable** key (public; handed to the browser for Stripe.js). */
  publishableKey: string;
  /** Captcha **site** key (public; handed to the browser widget). */
  captchaSiteKey: string;
  /** Per-IP rate-limit counter store. Defaults to in-memory (per-instance). */
  rateLimitStore?: RateLimitStore;
  /** Session lifetime in ms. Defaults to 30m. */
  ttlMs?: number;
  /** Injectable clock (ms). Defaults to `Date.now`. */
  now?: () => number;
  /** Filesystem path to the built signup SPA (`signup/dist`); serves the front-end when set. */
  staticRoot?: string;
}

const StartSchema = z.object({
  email: z.string().email().max(320),
  captchaToken: z.string().min(1).max(4096),
});
const VerifySchema = z.object({ code: z.string().min(1).max(16) });
const CompleteSchema = z.object({
  slug: z.string().min(1).max(64),
  region: z.string().min(1).max(64).optional(),
  residency: z.enum(['us', 'eu', 'apac']).optional(),
  planId: z.string().min(1).max(64).optional(),
});

/** Sign a payload with the session secret (base64url HMAC-SHA256). */
function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Encode a signed, expiring signup session carrying the opaque signup id. */
function encodeSession(signupId: string, secret: string, expMs: number): string {
  const body = Buffer.from(JSON.stringify({ id: signupId, exp: expMs }), 'utf8').toString(
    'base64url',
  );
  return `${body}.${sign(body, secret)}`;
}

/** Verify + decode a signup-session cookie; null if missing/tampered/expired (fail closed). */
function decodeSession(value: string, secret: string, nowMs: number): string | null {
  const dot = value.indexOf('.');
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  const got = Buffer.from(value.slice(dot + 1));
  const want = Buffer.from(sign(body, secret));
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (typeof p.exp !== 'number' || p.exp < nowMs) return null;
    if (typeof p.id !== 'string') return null;
    return p.id;
  } catch {
    return null;
  }
}

/** Best-effort client IP (X-Forwarded-For first hop), for unauthenticated rate-limit keying. */
function clientIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for');
  if (xff !== undefined && xff.length > 0) return xff.split(',')[0]!.trim();
  return c.req.header('x-real-ip') ?? 'unknown';
}

/** Map a facade error to a safe HTTP status (the message is user-actionable, never internal detail). */
function statusFor(message: string): number {
  if (/not configured/.test(message)) return 503;
  if (/unknown signup|no verification code/.test(message)) return 404;
  if (/captcha|invalid verification code|expired|too many attempts/.test(message)) return 400;
  if (/slug unavailable/.test(message)) return 409;
  if (/not confirmed|verify your email|add a payment method|mismatch|unknown plan/.test(message)) {
    return 409;
  }
  return 400;
}

/**
 * Build the TenantForge **self-serve signup backend** — the public, unauthenticated JSON API behind
 * the signup SPA. A short-lived, signed, HttpOnly, `SameSite=Strict` cookie carries the opaque signup
 * id across steps (no token in client storage). Every endpoint is **per-IP rate-limited** (the flow
 * is unauthenticated and abuse-prone) and body-size capped; the captcha + email-verification gates and
 * all provisioning logic live in the {@link TenantForge} facade. `GET /api/config` exposes only the
 * **public** Stripe publishable + captcha site keys. Card data never touches this server.
 *
 * @param options - Service, session secret, public keys, optional rate-limit store / ttl / clock / SPA root.
 * @returns A Hono sub-app (mount it under `/signup`).
 */
export function createSignup(options: SignupOptions): Hono {
  const app = new Hono();
  const now = options.now ?? ((): number => Date.now());
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const secret = options.sessionSecret;
  const store = options.rateLimitStore ?? createInMemoryRateLimitStore();

  const setSession = (c: Context, signupId: string): void =>
    setCookie(c, COOKIE, encodeSession(signupId, secret, now() + ttlMs), {
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      path: '/signup',
      maxAge: Math.floor(ttlMs / 1000),
    });

  const requireSession = (c: Context): string | null => {
    const raw = getCookie(c, COOKIE);
    return raw === undefined ? null : decodeSession(raw, secret, now());
  };

  /** Per-IP fixed-window limiter; returns true when the caller is over the cap (429 already sent). */
  const limited = async (
    c: Context,
    bucket: string,
    max: number,
    windowMs = 60_000,
  ): Promise<boolean> => {
    const { count, windowStartMs } = await store.increment(
      `signup:${bucket}:${clientIp(c)}`,
      windowMs,
      now(),
    );
    if (count > max) {
      c.header('Retry-After', String(Math.ceil((windowStartMs + windowMs - now()) / 1000)));
      return true;
    }
    return false;
  };

  /** Parse a JSON body against a schema; ok with the data, or a ready 400 Response to return. */
  async function read<T>(
    c: Context,
    schema: z.ZodType<T>,
  ): Promise<{ ok: true; data: T } | { ok: false; res: Response }> {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return { ok: false, res: c.json({ error: 'invalid JSON body' }, 400) };
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return { ok: false, res: c.json({ error: detail }, 400) };
    }
    return { ok: true, data: parsed.data };
  }

  app.use('/api/*', bodyLimit({ maxSize: MAX_BODY }));

  // Public config for the SPA (Stripe.js + captcha widget) — only public keys.
  app.get('/api/config', (c) =>
    c.json({ publishableKey: options.publishableKey, captchaSiteKey: options.captchaSiteKey }),
  );

  // Step 1: start — captcha + email; mints the signup-session cookie.
  app.post('/api/start', async (c) => {
    if (await limited(c, 'start', 5)) return c.json({ error: 'too many requests' }, 429);
    const parsed = await read(c, StartSchema);
    if (!parsed.ok) return parsed.res;
    try {
      const { signupId } = await options.tf.startSignup({ ...parsed.data, remoteIp: clientIp(c) });
      setSession(c, signupId);
      return c.json({ ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'error';
      return c.json({ error: msg }, statusFor(msg) as 400);
    }
  });

  // Step 2: verify the emailed code.
  app.post('/api/verify-email', async (c) => {
    if (await limited(c, 'verify', 10)) return c.json({ error: 'too many requests' }, 429);
    const signupId = requireSession(c);
    if (signupId === null) return c.json({ error: 'no signup session' }, 401);
    const parsed = await read(c, VerifySchema);
    if (!parsed.ok) return parsed.res;
    try {
      await options.tf.verifyEmail(signupId, parsed.data.code);
      return c.body(null, 204);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'error';
      return c.json({ error: msg }, statusFor(msg) as 400);
    }
  });

  // Step 3: create the PSP setup intent (tighter cap — this opens a Stripe call).
  app.post('/api/payment-intent', async (c) => {
    if (await limited(c, 'payment', 5)) return c.json({ error: 'too many requests' }, 429);
    const signupId = requireSession(c);
    if (signupId === null) return c.json({ error: 'no signup session' }, 401);
    try {
      const setup = await options.tf.createPaymentSetup(signupId);
      return c.json({ ...setup, publishableKey: options.publishableKey });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'error';
      return c.json({ error: msg }, statusFor(msg) as 400);
    }
  });

  // Step 4: complete — verifies the saved payment method server-side + enqueues provision.
  app.post('/api/complete', async (c) => {
    if (await limited(c, 'complete', 10)) return c.json({ error: 'too many requests' }, 429);
    const signupId = requireSession(c);
    if (signupId === null) return c.json({ error: 'no signup session' }, 401);
    const parsed = await read(c, CompleteSchema);
    if (!parsed.ok) return parsed.res;
    const body = parsed.data;
    try {
      const status = await options.tf.completeSignup(signupId, {
        slug: body.slug,
        ...(body.region !== undefined ? { region: body.region } : {}),
        ...(body.residency !== undefined ? { residency: body.residency } : {}),
        ...(body.planId !== undefined ? { planId: body.planId } : {}),
      });
      return c.json(status);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'error';
      return c.json({ error: msg }, statusFor(msg) as 400);
    }
  });

  // Status poll (one-time connection reveal happens server-side when active).
  app.get('/api/status', async (c) => {
    if (await limited(c, 'status', 60)) return c.json({ error: 'too many requests' }, 429);
    const signupId = requireSession(c);
    if (signupId === null) return c.json({ error: 'no signup session' }, 401);
    try {
      return c.json(await options.tf.signupStatus(signupId));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'error';
      return c.json({ error: msg }, statusFor(msg) as 400);
    }
  });

  // Serve the signup SPA when built. Scoped CSP allows Stripe.js + Turnstile (the dashboard's strict
  // CSP would block them); applied only on this sub-app's static routes, not the rest of the server.
  if (options.staticRoot !== undefined) {
    const root = options.staticRoot;
    const rewriteRequestPath = (p: string): string => p.replace(/^\/signup/, '') || '/';
    const csp: MiddlewareHandler = secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://js.stripe.com', 'https://challenges.cloudflare.com'],
        frameSrc: [
          'https://js.stripe.com',
          'https://hooks.stripe.com',
          'https://challenges.cloudflare.com',
        ],
        connectSrc: ["'self'", 'https://api.stripe.com'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    });
    app.get('/*', csp, serveStatic({ root, rewriteRequestPath }));
    app.get('/*', csp, serveStatic({ path: 'index.html', root }));
  }

  return app;
}
