import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import { can } from '../core/index.js';
import type { Authenticator, Principal } from '../ports/authenticator.js';
import type { TenantForge } from './lib.js';

/** Session cookie name (scoped to the dashboard path). */
const COOKIE = 'tf_dash';
/** Default session lifetime: 8 hours. */
const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;

/** Options for {@link createDashboard}. */
export interface DashboardOptions {
  /** The TenantForge service the dashboard reads. */
  tf: TenantForge;
  /** Resolves an operator token to a principal (the same authenticator the API uses). */
  authenticator: Authenticator;
  /** HMAC key signing the session cookie (a secret; required). */
  sessionSecret: string;
  /** Session lifetime in ms. Defaults to 8h. */
  ttlMs?: number;
  /** Injectable clock (ms). Defaults to `Date.now`. */
  now?: () => number;
}

const LoginSchema = z.object({ token: z.string().min(1) });

/** Sign a payload with the session secret (base64url HMAC-SHA256). */
function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Encode a signed, expiring session for a principal. */
function encodeSession(principal: Principal, secret: string, expMs: number): string {
  const body = Buffer.from(
    JSON.stringify({ id: principal.id, role: principal.role, exp: expMs }),
    'utf8',
  ).toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

/** Verify + decode a session cookie; null if missing/tampered/expired (fail closed). */
function decodeSession(value: string, secret: string, nowMs: number): Principal | null {
  const dot = value.indexOf('.');
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  const expected = sign(body, secret);
  const got = Buffer.from(mac);
  const want = Buffer.from(expected);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (typeof p.exp !== 'number' || p.exp < nowMs) return null;
    if (
      typeof p.id !== 'string' ||
      (p.role !== 'admin' && p.role !== 'operator' && p.role !== 'readonly')
    ) {
      return null;
    }
    return { id: p.id, role: p.role };
  } catch {
    return null;
  }
}

/**
 * Build the TenantForge **dashboard backend**: a small JSON API the web dashboard (SPA) calls,
 * authenticated by a **signed, HttpOnly session cookie** minted from an operator token (cookie ≠
 * bearer-in-the-browser; no token in client storage — topic-web-frontend / topic-authn-authz). The
 * cookie is `SameSite=Strict` (CSRF defence for the cookie-auth'd routes) and path-scoped to the
 * dashboard. Reuses the API's authenticator + the core `can` authorization. Read-only for now.
 *
 * @param options - The service, authenticator, session secret, and optional ttl/clock.
 * @returns A Hono sub-app (mount it under `/dashboard`).
 */
export function createDashboard(options: DashboardOptions): Hono {
  const app = new Hono();
  const now = options.now ?? ((): number => Date.now());
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const secret = options.sessionSecret;

  /** Resolve the current principal from the session cookie, or null. */
  const session = (c: Context): Principal | null => {
    const raw = getCookie(c, COOKIE);
    return raw === undefined ? null : decodeSession(raw, secret, now());
  };

  // Exchange an operator token for a session cookie (login).
  app.post('/api/session', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const parsed = LoginSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'token is required' }, 400);
    const principal = await options.authenticator.authenticate(parsed.data.token);
    if (principal === null) return c.json({ error: 'invalid token' }, 401);
    setCookie(c, COOKIE, encodeSession(principal, secret, now() + ttlMs), {
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      path: '/dashboard',
      maxAge: Math.floor(ttlMs / 1000),
    });
    return c.json({ id: principal.id, role: principal.role });
  });

  // Who am I (the SPA checks this on load); 401 if no valid session.
  app.get('/api/session', (c) => {
    const principal = session(c);
    return principal === null
      ? c.json({ error: 'not authenticated' }, 401)
      : c.json({ id: principal.id, role: principal.role });
  });

  // Logout: clear the cookie.
  app.delete('/api/session', (c) => {
    deleteCookie(c, COOKIE, { path: '/dashboard' });
    return c.body(null, 204);
  });

  // Compliance report panel data (read).
  app.get('/api/compliance', async (c) => {
    const principal = session(c);
    if (principal === null) return c.json({ error: 'not authenticated' }, 401);
    if (!can(principal, 'tenant:read')) return c.json({ error: 'forbidden' }, 403);
    const { report, digest } = await options.tf.complianceReport();
    return c.json({ report, digest });
  });

  return app;
}
