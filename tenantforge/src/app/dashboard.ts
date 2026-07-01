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
/** The custom header carrying the signed per-session CSRF token (gap #7 — mirrors the portal). */
const CSRF_HEADER = 'x-tf-csrf';

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
  /**
   * Allowed browser origins for state-changing requests (e.g. `https://ops.example.com`). When set, a
   * mutation's `Origin` (if present) must be in this list — combined with the `Sec-Fetch-Site` check +
   * the signed CSRF token (gap #7, mirrors the portal). Empty/unset ⇒ rely on `Sec-Fetch-Site` + the
   * CSRF token (same-origin). `SameSite=Strict` on the cookie remains a backstop, not the control.
   */
  allowedOrigins?: string[];
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

/** A decoded, verified dashboard session: the principal and the cookie's absolute expiry (epoch ms). */
interface Session {
  /** The authenticated operator principal (server-derived; never from request input). */
  principal: Principal;
  /** The session cookie's absolute expiry (epoch ms) — also the CSRF token's binding value. */
  exp: number;
}

/** Verify + decode a session cookie to its principal + expiry; null if missing/tampered/expired. */
function decodeSessionInfo(value: string, secret: string, nowMs: number): Session | null {
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
    return { principal: { id: p.id, role: p.role }, exp: p.exp };
  } catch {
    return null;
  }
}

/**
 * Mint a **signed, session-bound CSRF token**: `{id}.HMAC(csrf:{id}:{exp}, secret)`, where `exp` is the
 * live session cookie's expiry. The browser reads it (`GET /api/csrf`) and echoes it in the
 * {@link CSRF_HEADER} on every mutation; the server re-derives from the *current* session and
 * constant-time compares. Bound to the session's `exp`, it **rotates with the cookie and dies on
 * expiry/logout** — a leaked token is not a forever-valid bypass. A **signed** token (not a bare
 * double-submit value a subdomain/cookie-injection could forge), carrying the principal id so a token
 * for one operator can't be replayed as another. Mirrors the portal's `mintCsrf`.
 */
function mintCsrf(session: Session, secret: string): string {
  return `${session.principal.id}.${sign(`csrf:${session.principal.id}:${session.exp}`, secret)}`;
}

/** Verify a presented CSRF token against the **current** session (constant-time, session-bound). */
function verifyCsrf(token: string | undefined, session: Session, secret: string): boolean {
  if (token === undefined) return false;
  const expected = mintCsrf(session, secret);
  const got = Buffer.from(token);
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Build the TenantForge **dashboard backend**: a small JSON API the web dashboard (SPA) calls,
 * authenticated by a **signed, HttpOnly session cookie** minted from an operator token (cookie ≠
 * bearer-in-the-browser; no token in client storage — topic-web-frontend / topic-authn-authz). The
 * cookie is `SameSite=Strict` and path-scoped to the dashboard. State-changing routes (execute
 * reconcile, logout) additionally require a **signed, session-bound CSRF token** in the
 * {@link CSRF_HEADER} plus an `Origin`/`Sec-Fetch-Site` allow-list (gap #7, mirroring the portal) —
 * defense in depth over the SameSite backstop; login (`POST /api/session`) is exempt (no session
 * exists yet — it's defended by the operator token + SameSite). Reuses the API's authenticator + the
 * core `can` authorization.
 *
 * @param options - The service, authenticator, session secret, and optional ttl/clock.
 * @returns A Hono sub-app (mount it under `/dashboard`).
 */
export function createDashboard(options: DashboardOptions): Hono {
  const app = new Hono();
  const now = options.now ?? ((): number => Date.now());
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const secret = options.sessionSecret;

  const allowedOrigins = options.allowedOrigins ?? [];

  /** Resolve the full session ({ principal, exp }) from the cookie, or null (fail closed). */
  const sessionInfo = (c: Context): Session | null => {
    const raw = getCookie(c, COOKIE);
    return raw === undefined ? null : decodeSessionInfo(raw, secret, now());
  };

  /** Resolve the current principal from the session cookie, or null. */
  const session = (c: Context): Principal | null => sessionInfo(c)?.principal ?? null;

  /**
   * CSRF guard for state-changing routes (gap #7 — mirrors the portal): a **signed per-session token**
   * in {@link CSRF_HEADER} (not a bare double-submit a subdomain could forge), plus an
   * `Origin`/`Sec-Fetch-Site` allow-list as defense in depth. `SameSite=Strict` on the cookie is a
   * backstop, not the control. Returns a ready 403 Response when the request fails the check, else null.
   */
  const csrfRejected = (c: Context, principal: Principal): Response | null => {
    // `Sec-Fetch-Site` (sent by modern browsers, not forgeable by JS): only same-origin/none allowed.
    const site = c.req.header('sec-fetch-site');
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      return c.json({ error: 'cross-site request rejected' }, 403);
    }
    // When an Origin is present, it must be in the allow-list (if one is configured).
    const origin = c.req.header('origin');
    if (origin !== undefined && allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) {
      return c.json({ error: 'origin not allowed' }, 403);
    }
    // The CSRF token must verify against the LIVE session — bound to this session's expiry (rotates
    // with the cookie, dies on expiry/logout) and to this principal. A session that vanished
    // mid-request (logout/expiry) fails closed here.
    const live = sessionInfo(c);
    if (live === null || live.principal.id !== principal.id) {
      return c.json({ error: 'no session' }, 403);
    }
    if (!verifyCsrf(c.req.header(CSRF_HEADER), live, secret)) {
      return c.json({ error: 'missing or invalid CSRF token' }, 403);
    }
    return null;
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

  // Issue the session-bound CSRF token (the SPA reads this then echoes it in the CSRF header on every
  // mutation). Minted from the live session's expiry, so it rotates with the cookie and dies on
  // expiry/logout. Requires a valid session (mirrors the portal's GET /api/csrf).
  app.get('/api/csrf', (c) => {
    const live = sessionInfo(c);
    if (live === null) return c.json({ error: 'not authenticated' }, 401);
    return c.json({ csrfToken: mintCsrf(live, secret) });
  });

  // Logout: clear the cookie. State-changing → CSRF-guarded (a signed session-bound token) so a
  // cross-site page can't force-logout an operator (mirrors the portal's mutation guard — gap #7).
  app.delete('/api/session', (c) => {
    const principal = session(c);
    // No session ⇒ logout is already a no-op; return 204 idempotently (nothing to protect).
    if (principal !== null) {
      const csrf = csrfRejected(c, principal);
      if (csrf !== null) return csrf;
    }
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

  // Evidence-bundle manifests panel data (ADR-0011 Phase 3c). FACTS ONLY (no JWS body) — the same
  // operator-gated `evidence:read` the HTTP API uses (held by admin+operator, NOT readonly). The
  // tenant scope is server-derived (operator surface = fleet-wide); there is NO client-supplied
  // tenant-id (BOLA — the project's #1 risk). `?scope` is validated here; the result set is bounded by
  // the store's default page size (the dashboard route does not expose `?limit`).
  app.get('/api/evidence/bundles', async (c) => {
    const principal = session(c);
    if (principal === null) return c.json({ error: 'not authenticated' }, 401);
    if (!can(principal, 'evidence:read')) return c.json({ error: 'forbidden' }, 403);
    const scopeParam = c.req.query('scope');
    if (scopeParam !== undefined && scopeParam !== 'fleet' && scopeParam !== 'tenant') {
      return c.json({ error: 'scope must be "fleet" or "tenant"' }, 400);
    }
    const manifests = await options.tf.evidenceList({
      ...(scopeParam === 'fleet' || scopeParam === 'tenant' ? { scope: scopeParam } : {}),
    });
    return c.json({ manifests });
  });

  // A single signed evidence bundle (`{ bundle, jws }`) by id — for offline verification / download.
  // Operator/fleet scope (`null`): the `:bundleId` is a non-guessable handle, never a tenant selector.
  // A 404 (unknown or out-of-scope) reveals nothing about whether the id exists elsewhere.
  app.get('/api/evidence/bundles/:bundleId', async (c) => {
    const principal = session(c);
    if (principal === null) return c.json({ error: 'not authenticated' }, 401);
    if (!can(principal, 'evidence:read')) return c.json({ error: 'forbidden' }, 403);
    const signed = await options.tf.evidenceGet(c.req.param('bundleId'), null);
    if (signed === null) return c.json({ error: 'not found' }, 404);
    return c.json({ bundle: signed.bundle, jws: signed.jws });
  });

  // The evidence-bundle PUBLIC verification key (Ed25519 JWK). This is the deliberately *public* key
  // an auditor uses to verify a bundle offline — no extra permission beyond a valid dashboard session
  // (it carries no private material). 404 when no evidence-bundle signer is wired.
  app.get('/api/evidence/public-key', async (c) => {
    const principal = session(c);
    if (principal === null) return c.json({ error: 'not authenticated' }, 401);
    const jwk = await options.tf.evidenceBundlePublicKey();
    if (jwk === null) return c.json({ error: 'no evidence-bundle signer is configured' }, 404);
    return c.json({ publicKey: jwk });
  });

  // Operator alert digest panel data (read-only roll-up of all detectors).
  app.get('/api/operator-digest', async (c) => {
    const principal = session(c);
    if (principal === null) return c.json({ error: 'not authenticated' }, 401);
    if (!can(principal, 'tenant:read')) return c.json({ error: 'forbidden' }, 403);
    return c.json(await options.tf.operatorDigest());
  });

  // Webhook subscriptions panel data (read-only; never the signing secret).
  app.get('/api/webhook-subscriptions', async (c) => {
    const principal = session(c);
    if (principal === null) return c.json({ error: 'not authenticated' }, 401);
    if (!can(principal, 'webhooks:read')) return c.json({ error: 'forbidden' }, 403);
    return c.json({ subscriptions: await options.tf.listWebhookSubscriptions() });
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

  // Cost/margin anomalies for the current month (read-only; default thresholds → unprofitable + unpriced).
  app.get('/api/cost-anomalies', async (c) => {
    const principal = session(c);
    if (principal === null) return c.json({ error: 'not authenticated' }, 401);
    if (!can(principal, 'tenant:read')) return c.json({ error: 'forbidden' }, 403);
    const to = new Date(now());
    const from = new Date(to.getFullYear(), to.getMonth(), 1);
    return c.json({ anomalies: await options.tf.scanCostAnomalies({ from, to }) });
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

  // Recent inbound payment-webhook events (read-only).
  app.get('/api/payment-events', async (c) => {
    const principal = session(c);
    if (principal === null) return c.json({ error: 'not authenticated' }, 401);
    if (!can(principal, 'tenant:read')) return c.json({ error: 'forbidden' }, 403);
    return c.json({ events: await options.tf.paymentWebhookHistory() });
  });

  // Recent dunning history (read-only; the dunning RUN moves money + suspends, so it is CLI/gated).
  app.get('/api/dunning', async (c) => {
    const principal = session(c);
    if (principal === null) return c.json({ error: 'not authenticated' }, 401);
    if (!can(principal, 'tenant:read')) return c.json({ error: 'forbidden' }, 403);
    return c.json({ events: await options.tf.dunningHistory() });
  });

  // Recent billing-run history (read-only; the RUN charges the fleet + suspends, so it is CLI/gated).
  app.get('/api/billing-runs', async (c) => {
    const principal = session(c);
    if (principal === null) return c.json({ error: 'not authenticated' }, 401);
    if (!can(principal, 'tenant:read')) return c.json({ error: 'forbidden' }, 403);
    return c.json({ runs: await options.tf.billingRunHistory() });
  });

  // Recent refund history (read-only; issuing a refund returns real money, so it is CLI/gated).
  app.get('/api/refunds', async (c) => {
    const principal = session(c);
    if (principal === null) return c.json({ error: 'not authenticated' }, 401);
    if (!can(principal, 'tenant:read')) return c.json({ error: 'forbidden' }, 403);
    return c.json({ refunds: await options.tf.refundHistory() });
  });

  // Recent billing-receipt notifications (read-only).
  app.get('/api/notifications', async (c) => {
    const principal = session(c);
    if (principal === null) return c.json({ error: 'not authenticated' }, 401);
    if (!can(principal, 'tenant:read')) return c.json({ error: 'forbidden' }, 403);
    return c.json({ notifications: await options.tf.notificationHistory() });
  });

  // Recent plan-change history (read-only; applying a change is a CLI op).
  app.get('/api/plan-changes', async (c) => {
    const principal = session(c);
    if (principal === null) return c.json({ error: 'not authenticated' }, 401);
    if (!can(principal, 'tenant:read')) return c.json({ error: 'forbidden' }, 403);
    return c.json({ planChanges: await options.tf.planChangeHistory() });
  });

  // Recent credit-grant history (read-only; granting is a CLI op).
  app.get('/api/credit-grants', async (c) => {
    const principal = session(c);
    if (principal === null) return c.json({ error: 'not authenticated' }, 401);
    if (!can(principal, 'tenant:read')) return c.json({ error: 'forbidden' }, 403);
    return c.json({ creditGrants: await options.tf.creditGrantHistory() });
  });

  // Recent usage-alert history (read-only; the sweep that emits alerts is a CLI op).
  app.get('/api/usage-alerts', async (c) => {
    const principal = session(c);
    if (principal === null) return c.json({ error: 'not authenticated' }, 401);
    if (!can(principal, 'tenant:read')) return c.json({ error: 'forbidden' }, 403);
    return c.json({ usageAlerts: await options.tf.usageAlertHistory() });
  });

  // Retention report (read-only): archived tenants scheduled for purge (configured window).
  app.get('/api/retention', async (c) => {
    const principal = session(c);
    if (principal === null) return c.json({ error: 'not authenticated' }, 401);
    if (!can(principal, 'tenant:read')) return c.json({ error: 'forbidden' }, 403);
    return c.json(await options.tf.retentionReport());
  });

  // Recent data-export history (read-only; the export reads tenant data and is a CLI op).
  app.get('/api/exports', async (c) => {
    const principal = session(c);
    if (principal === null) return c.json({ error: 'not authenticated' }, 401);
    if (!can(principal, 'tenant:read')) return c.json({ error: 'forbidden' }, 403);
    return c.json({ exports: await options.tf.exportHistory() });
  });

  // The operator's plan catalog (read-only; assigning a plan is a CLI op).
  app.get('/api/plans', (c) => {
    const principal = session(c);
    if (principal === null) return c.json({ error: 'not authenticated' }, 401);
    if (!can(principal, 'tenant:read')) return c.json({ error: 'forbidden' }, 403);
    return c.json({ plans: options.tf.listPlans() });
  });

  // Signup-token status (read-only; issuing/redeeming is a CLI op that provisions resources).
  app.get('/api/signup-tokens', async (c) => {
    const principal = session(c);
    if (principal === null) return c.json({ error: 'not authenticated' }, 401);
    if (!can(principal, 'tenant:read')) return c.json({ error: 'forbidden' }, 403);
    return c.json({ signupTokens: await options.tf.listSignupTokens() });
  });

  // Recent invoice-delivery history (read-only; sending an invoice email is a CLI op).
  app.get('/api/invoices-sent', async (c) => {
    const principal = session(c);
    if (principal === null) return c.json({ error: 'not authenticated' }, 401);
    if (!can(principal, 'tenant:read')) return c.json({ error: 'forbidden' }, 403);
    return c.json({ invoicesSent: await options.tf.invoiceDeliveryHistory() });
  });

  // Recent control-plane audit trail (read-only; the newest slice across all event types).
  app.get('/api/audit', async (c) => {
    const principal = session(c);
    if (principal === null) return c.json({ error: 'not authenticated' }, 401);
    if (!can(principal, 'tenant:read')) return c.json({ error: 'forbidden' }, 403);
    return c.json({ events: await options.tf.queryAudit({ limit: 50 }) });
  });

  // Audit anomalies over the recent window (read-only; error spikes + per-actor/tenant clusters).
  app.get('/api/audit-anomalies', async (c) => {
    const principal = session(c);
    if (principal === null) return c.json({ error: 'not authenticated' }, 401);
    if (!can(principal, 'tenant:read')) return c.json({ error: 'forbidden' }, 403);
    return c.json({ anomalies: await options.tf.scanAuditAnomalies() });
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
  // default — readonly/operator-without-it get 403), and a server-configured SQL catalog. CSRF is
  // defended in depth: a signed session-bound token in the CSRF header + Origin/Sec-Fetch-Site
  // allow-list (gap #7), on top of the SameSite=Strict cookie backstop. Audited via fleet.reconcile.
  app.post('/api/reconcile', async (c) => {
    const principal = session(c);
    if (principal === null) return c.json({ error: 'not authenticated' }, 401);
    if (!can(principal, 'tenant:provision')) return c.json({ error: 'forbidden' }, 403);
    const csrf = csrfRejected(c, principal);
    if (csrf !== null) return csrf;
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
