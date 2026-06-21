import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import { can } from '../core/index.js';
import type { Authenticator, Principal } from '../ports/authenticator.js';
import type { TenantForge } from './lib.js';
import type { FleetMigrationSpec } from '../adapters/fleet-orchestrator.js';

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
  /**
   * Filesystem path to the built SPA (`dashboard/dist`). When set, the dashboard also **serves the
   * static front-end** (index + hashed assets) so a production deploy needs no separate web server;
   * unknown sub-paths fall back to `index.html` (client-side routing). Unset = JSON API only (the
   * SPA is served by Vite in dev).
   */
  staticRoot?: string;
  /**
   * The migration SQL catalog (ordered). When set, the dashboard exposes a **`tenant:provision`-gated
   * POST** to *execute* a fleet reconcile from the browser (the mutating action behind the read-only
   * plan). Unset = preview only (execution stays a CLI op — the server has no SQL to apply).
   */
  reconcileCatalog?: readonly FleetMigrationSpec[];
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

  // Fleet schema-version drift panel data (read).
  app.get('/api/drift', async (c) => {
    const principal = session(c);
    if (principal === null) return c.json({ error: 'not authenticated' }, 401);
    if (!can(principal, 'tenant:read')) return c.json({ error: 'forbidden' }, 403);
    return c.json(await options.tf.fleetStatus());
  });

  // Cost/margin panel data (read) — current calendar month to now.
  app.get('/api/cost', async (c) => {
    const principal = session(c);
    if (principal === null) return c.json({ error: 'not authenticated' }, 401);
    if (!can(principal, 'tenant:read')) return c.json({ error: 'forbidden' }, 403);
    const to = new Date(now());
    const from = new Date(to.getFullYear(), to.getMonth(), 1);
    return c.json(await options.tf.costReport({ from, to }));
  });

  // Fleet invoices panel data (current calendar month → now).
  app.get('/api/invoices', async (c) => {
    const principal = session(c);
    if (principal === null) return c.json({ error: 'not authenticated' }, 401);
    if (!can(principal, 'tenant:read')) return c.json({ error: 'forbidden' }, 403);
    const to = new Date(now());
    const from = new Date(to.getFullYear(), to.getMonth(), 1);
    return c.json(await options.tf.invoiceFleet({ from, to }));
  });

  // Fleet reconcile plan panel data (read-only preview — applies nothing).
  app.get('/api/reconcile', async (c) => {
    const principal = session(c);
    if (principal === null) return c.json({ error: 'not authenticated' }, 401);
    if (!can(principal, 'tenant:read')) return c.json({ error: 'forbidden' }, 403);
    return c.json(await options.tf.reconcilePlan());
  });

  // Recent reconcile history from the persisted audit trail ([] without an audit store).
  app.get('/api/reconcile-history', async (c) => {
    const principal = session(c);
    if (principal === null) return c.json({ error: 'not authenticated' }, 401);
    if (!can(principal, 'tenant:read')) return c.json({ error: 'forbidden' }, 403);
    return c.json({ history: await options.tf.reconcileHistory() });
  });

  // Recent charge history (read-only; charging is a CLI/gated op, not a dashboard action).
  app.get('/api/charges', async (c) => {
    const principal = session(c);
    if (principal === null) return c.json({ error: 'not authenticated' }, 401);
    if (!can(principal, 'tenant:read')) return c.json({ error: 'forbidden' }, 403);
    return c.json({ charges: await options.tf.chargeHistory() });
  });

  // Whether reconcile can be EXECUTED from the dashboard (a SQL catalog is wired) and whether this
  // principal may (tenant:provision). The SPA uses this to decide whether to show the Run button.
  app.get('/api/reconcile/capabilities', (c) => {
    const principal = session(c);
    if (principal === null) return c.json({ error: 'not authenticated' }, 401);
    return c.json({
      executable: options.reconcileCatalog !== undefined,
      mayExecute: can(principal, 'tenant:provision'),
    });
  });

  // EXECUTE a fleet reconcile (mutating, gated). Requires a session, `tenant:provision` (deny by
  // default — readonly/operator-without-it get 403), and a server-configured SQL catalog. The
  // SameSite=Strict session cookie defends against CSRF. Audited via the fleet.reconcile event.
  app.post('/api/reconcile', async (c) => {
    const principal = session(c);
    if (principal === null) return c.json({ error: 'not authenticated' }, 401);
    if (!can(principal, 'tenant:provision')) return c.json({ error: 'forbidden' }, 403);
    if (options.reconcileCatalog === undefined) {
      return c.json({ error: 'reconcile execution is not enabled on this server' }, 409);
    }
    const report = await options.tf.reconcileFleet(options.reconcileCatalog);
    return c.json(report);
  });

  // Serve the built SPA (registered AFTER the /api routes so it never shadows them). serveStatic
  // calls next() on a miss, so the `*` fallback returns index.html for client-side routes.
  if (options.staticRoot !== undefined) {
    const root = options.staticRoot;
    // This sub-app is mounted at /dashboard, but serveStatic resolves files from the *original*
    // (un-stripped) request path — strip the mount prefix so `/dashboard/assets/x` → `root/assets/x`.
    const rewriteRequestPath = (p: string): string => p.replace(/^\/dashboard/, '') || '/';
    // Canonical Hono SPA recipe: serve a real file when it exists (serveStatic calls next() on a
    // miss), otherwise fall back to index.html for client-side routes.
    app.get('/*', serveStatic({ root, rewriteRequestPath }));
    app.get('/*', serveStatic({ path: 'index.html', root }));
  }

  return app;
}
