import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import type { TenantForge, TenantSummary } from './lib.js';
import type { TenantAuthenticator } from '../ports/tenant-authenticator.js';
import type { OidcCodeFlow } from '../ports/oidc-code-flow.js';
import type { TenantEvent, TenantUsage } from '../core/index.js';
import type { RateLimitStore } from '../ports/rate-limit-store.js';
import type { IdempotencyStore, IdempotentResponse } from '../ports/idempotency-store.js';
import { createInMemoryRateLimitStore } from '../adapters/rate-limit-store.js';
import { createInMemoryIdempotencyStore } from '../adapters/idempotency-store.js';

/** Portal session cookie name (scoped to the portal path). */
const COOKIE = 'tf_portal';
/** Transient OIDC login cookie: pins `state`/`nonce`/`codeVerifier` between start + callback. */
const LOGIN_COOKIE = 'tf_portal_login';
/** Default portal session lifetime: 1 hour (customer-facing → shorter than the operator dashboard). */
const DEFAULT_TTL_MS = 60 * 60 * 1000;
/** OIDC login flow lifetime: 10 minutes (the user redirects to the IdP and back well within this). */
const LOGIN_TTL_MS = 10 * 60 * 1000;
/** Portal API request bodies are tiny — cap hard (DoS / `std-owasp-api` API4). */
const MAX_BODY = 8 * 1024;
/** The custom header carrying the signed per-session CSRF token (red-team F4). */
const CSRF_HEADER = 'x-tf-csrf';

/** Options for {@link createPortal}. */
export interface PortalOptions {
  /** The TenantForge service the portal reads (tenant-scoped reads only). */
  tf: TenantForge;
  /** Resolves a portal token to the tenant it authenticates as (static/dev token mode). */
  authenticator: TenantAuthenticator;
  /**
   * Server-side OIDC Authorization Code + PKCE flow. When set, the SPA logs in via the code flow
   * (`GET /api/login/start` → IdP → `POST /api/session {code,state}`): the SPA never handles a raw
   * token, and `state`/`nonce`/`code_verifier` are pinned server-side (defeats login-CSRF + replay —
   * H1/H2). Unset ⇒ only the static/dev-token path (`POST /api/session {token}`) is available.
   */
  codeFlow?: OidcCodeFlow;
  /** HMAC key signing the session cookie (a secret; required). */
  sessionSecret: string;
  /** Session lifetime in ms. Defaults to 1h. */
  ttlMs?: number;
  /** Injectable clock (ms). Defaults to `Date.now`. */
  now?: () => number;
  /** Per-session/per-IP rate-limit counter store. Defaults to in-memory (per-instance). */
  rateLimitStore?: RateLimitStore;
  /** Endpoint-level idempotency store for money ops. Defaults to in-memory (per-instance). */
  idempotencyStore?: IdempotencyStore;
  /**
   * Allowed browser origins for state-changing requests (e.g. `https://portal.example.com`). When set,
   * a mutation's `Origin` must be in this list (combined with the `Sec-Fetch-Site` check + the signed
   * CSRF token — red-team F4). Empty/unset ⇒ rely on `Sec-Fetch-Site` + CSRF token (same-origin).
   */
  allowedOrigins?: string[];
  /**
   * Enable the **destructive** self-serve actions (cancel + erasure). Defaults to **false** — the pair
   * ships behind a feature flag that is OFF until its abuse tests are green + security-reviewed
   * (ADR-0010 / red-team F6). Payment / plan / invoices are unaffected by this flag.
   */
  enableDestructiveActions?: boolean;
  /**
   * Enable the **self-serve compliance-evidence** surface (ADR-0011 Phase 3d / threat-model B8e): a
   * tenant lists/downloads its **own** signed evidence bundles + the public key, and may
   * **self-generate** its own current bundle. Defaults to **false** — a benign **default-OFF rollout
   * flag** for staged rollout of a new customer-facing surface. It is **read-only/non-destructive**
   * (server-scoped assembly + sign + persist), so it is **independent of**
   * {@link PortalOptions.enableDestructiveActions} (which gates only cancel + erasure) — the two flags
   * must never be entangled. The routes only exist when this is true (an SPA that respects the
   * advertised capability never renders a control that would 404).
   */
  enableEvidence?: boolean;
  /**
   * Stripe **publishable** key (public; handed to the browser for Stripe Elements). Surfaced via
   * `GET /api/config` and on the setup-intent response so the SPA can load Stripe.js with it. Optional:
   * when unset, the payment-method view degrades gracefully (the server still fails closed on the
   * setup-intent call if a gateway isn't configured).
   */
  publishableKey?: string;
  /**
   * Filesystem path to the built portal SPA (`portal/dist`); serves the front-end + a scoped CSP that
   * allows Stripe.js (mirrors {@link import('./signup.js').createSignup}) when set. Unset = JSON API
   * only (the SPA is served by Vite in dev). The server-rendered no-JS page stays at `/portal`.
   */
  staticRoot?: string;
}

/** Sign a payload with the session secret (base64url HMAC-SHA256). */
function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Best-effort client IP (X-Forwarded-For first hop), for rate-limiting the unauthenticated login. */
function clientIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for');
  if (xff !== undefined && xff.length > 0) return xff.split(',')[0]!.trim();
  return c.req.header('x-real-ip') ?? 'unknown';
}

/** Encode a signed, expiring session for a tenant. */
function encodeSession(tenantId: string, secret: string, expMs: number): string {
  const body = Buffer.from(JSON.stringify({ tenantId, exp: expMs }), 'utf8').toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

/** A decoded, verified portal session: the tenant id and the cookie's absolute expiry (epoch ms). */
interface Session {
  /** The authenticated tenant id (server-derived; never from request input). */
  tenantId: string;
  /** The session cookie's absolute expiry (epoch ms) — also the CSRF token's binding value. */
  exp: number;
}

/** Verify + decode a session cookie; null if missing/tampered/expired (fail closed). */
function decodeSession(value: string, secret: string, nowMs: number): Session | null {
  const dot = value.indexOf('.');
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  const expected = sign(body, secret);
  const got = Buffer.from(value.slice(dot + 1));
  const want = Buffer.from(expected);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (typeof p.exp !== 'number' || p.exp < nowMs) return null;
    if (typeof p.tenantId !== 'string' || p.tenantId === '') return null;
    return { tenantId: p.tenantId, exp: p.exp };
  } catch {
    return null;
  }
}

/** The transient, server-pinned OIDC login flow params carried in the signed login cookie. */
interface LoginFlow {
  /** Anti-CSRF state the callback must echo back exactly. */
  state: string;
  /** Nonce bound into the request; the id_token's `nonce` claim must equal it (replay defence). */
  nonce: string;
  /** The PKCE code verifier (kept server-side; never sent to the SPA). */
  codeVerifier: string;
  /** Absolute expiry (epoch ms) — a short window for the IdP round-trip. */
  exp: number;
}

/** Encode a signed, short-TTL login cookie pinning the flow's state/nonce/verifier server-side. */
function encodeLogin(flow: LoginFlow, secret: string): string {
  const body = Buffer.from(JSON.stringify(flow), 'utf8').toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

/** Verify + decode the login cookie; null if missing/tampered/expired (fail closed). */
function decodeLogin(value: string, secret: string, nowMs: number): LoginFlow | null {
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
    if (typeof p.state !== 'string' || p.state === '') return null;
    if (typeof p.nonce !== 'string' || p.nonce === '') return null;
    if (typeof p.codeVerifier !== 'string' || p.codeVerifier === '') return null;
    return { state: p.state, nonce: p.nonce, codeVerifier: p.codeVerifier, exp: p.exp };
  } catch {
    return null;
  }
}

/**
 * Mint a **signed, session-bound CSRF token**: `tenantId.HMAC(csrf:{tenantId}:{exp}, secret)`, where
 * `exp` is the live session cookie's expiry. The browser reads it (`GET /api/csrf`) and echoes it in
 * the {@link CSRF_HEADER} on every mutation; the server re-derives from the *current* session and
 * constant-time compares. Because the token is bound to the session's `exp`, it **rotates with the
 * cookie and dies on expiry/logout** — a leaked token is not a forever-valid bypass (review L1). It is
 * a **signed** token (not a bare double-submit value a subdomain/cookie-injection could forge — F4),
 * and it carries the tenant so a token for A can't be replayed as B.
 */
function mintCsrf(session: Session, secret: string): string {
  return `${session.tenantId}.${sign(`csrf:${session.tenantId}:${session.exp}`, secret)}`;
}

/** Verify a presented CSRF token against the **current** session (constant-time, session-bound). */
function verifyCsrf(token: string | undefined, session: Session, secret: string): boolean {
  if (token === undefined) return false;
  const expected = mintCsrf(session, secret);
  const got = Buffer.from(token);
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** A non-negative, finite plan price in USD (≥ 0; bounded to avoid absurd values). */
const PlanChangeSchema = z.object({
  newPriceUsd: z.number().finite().nonnegative().max(1_000_000),
});
/** A confirmed PSP setup-intent id to verify + set as default. */
const SetDefaultSchema = z.object({ setupIntentId: z.string().min(1).max(256) });
/** Erasure request: the typed confirmation + the step-up code. */
const ErasureSchema = z.object({
  code: z.string().min(1).max(16),
  /** A typed confirmation phrase the SPA requires (defense in depth; also checked server-side). */
  confirm: z.literal('ERASE'),
});
/** Cancel request: the step-up code (cancel is reversible but still second-factor gated — F1). */
const CancelSchema = z.object({ code: z.string().min(1).max(16) });
/**
 * Portal login body for `POST /api/session`, one of two shapes:
 * - `{ code, state }` — the OIDC Authorization Code callback (the SPA never handles a token; the
 *   server exchanges the code + pinned verifier at the IdP and verifies the id_token + nonce — H1/H2).
 * - `{ token }` — the static/dev token path (token mode / local dev without a real IdP).
 * Bounded sizes (a code/state are short; a dev token is a small opaque value).
 */
const LoginSchema = z.union([
  z.object({
    code: z.string().min(1).max(4096),
    state: z.string().min(1).max(512),
  }),
  z.object({ token: z.string().min(1).max(8192) }),
]);

/** Map a facade error message to a safe HTTP status (the message is user-actionable, never internal). */
function statusFor(message: string): number {
  if (/not configured/.test(message)) return 503;
  if (/not found/.test(message)) return 404;
  if (
    /no billing customer|no verified email|not confirmed|mismatch|already in progress|already in flight/.test(
      message,
    )
  ) {
    return 409;
  }
  return 400;
}

/** Escape a value for safe interpolation into HTML text/attributes (XSS defence — defence in depth). */
function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Wrap page content in a minimal, WCAG-friendly HTML document (semantic, no external resources). */
function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; max-width: 50rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
caption { text-align: left; font-weight: 600; margin-bottom: 0.5rem; }
th, td { border: 1px solid currentColor; padding: 0.4rem 0.6rem; text-align: left; }
label { display: block; font-weight: 600; margin-bottom: 0.25rem; }
input { font: inherit; padding: 0.4rem; min-width: 16rem; }
button { font: inherit; padding: 0.5rem 1rem; cursor: pointer; }
.error { color: #b00020; font-weight: 600; }
:focus-visible { outline: 3px solid #2563eb; outline-offset: 2px; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

/** The login page (optionally with an error message). */
function loginPage(error?: string): string {
  return page(
    'Sign in — TenantForge portal',
    `<main>
<h1>Sign in</h1>
${error !== undefined ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/portal/login">
<p>
<label for="token">Portal token</label>
<input id="token" name="token" type="password" autocomplete="off" required>
</p>
<button type="submit">Sign in</button>
</form>
</main>`,
  );
}

/** A read-only table of audit events (charges or refunds), or a note when empty. */
function eventsTable(caption: string, events: TenantEvent[]): string {
  if (events.length === 0) return `<p>No ${esc(caption.toLowerCase())} yet.</p>`;
  const rows = events
    .map((e) => {
      const ctx = e.context ?? {};
      const amount = typeof ctx['amountMinor'] === 'number' ? String(ctx['amountMinor']) : '—';
      const currency = typeof ctx['currency'] === 'string' ? ctx['currency'] : '';
      const status = typeof ctx['status'] === 'string' ? ctx['status'] : e.outcome;
      return `<tr><td>${esc(e.at)}</td><td>${esc(amount)} ${esc(currency)}</td><td>${esc(status)}</td></tr>`;
    })
    .join('');
  return `<table>
<caption>${esc(caption)}</caption>
<thead><tr><th scope="col">When</th><th scope="col">Amount</th><th scope="col">Status</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

/** Humanize a byte count to a readable binary unit (display only). */
function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

/** Humanize a duration in seconds to a readable h/m/s string (display only). */
function humanSeconds(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** The tenant's metered usage for the current period (never exposes the internal Neon project id). */
function usageTable(usage: TenantUsage): string {
  const c = usage.consumption;
  return `<table>
<caption>Usage this period (${esc(usage.period.from)} – ${esc(usage.period.to)})</caption>
<thead><tr><th scope="col">Metric</th><th scope="col">Amount</th></tr></thead>
<tbody>
<tr><td>Compute time</td><td>${esc(humanSeconds(c.computeTimeSeconds))}</td></tr>
<tr><td>Active time</td><td>${esc(humanSeconds(c.activeTimeSeconds))}</td></tr>
<tr><td>Data written</td><td>${esc(humanBytes(c.writtenDataBytes))}</td></tr>
<tr><td>Storage (peak)</td><td>${esc(humanBytes(c.syntheticStorageBytes))}</td></tr>
</tbody>
</table>`;
}

/** A read-only table of receipt notifications (`tenant.notified` events), or a note when empty. */
function receiptsTable(events: TenantEvent[]): string {
  if (events.length === 0) return '<p>No receipts yet.</p>';
  const rows = events
    .map((e) => {
      const ctx = e.context ?? {};
      const kind = typeof ctx['kind'] === 'string' ? ctx['kind'] : '—';
      const reference = typeof ctx['reference'] === 'string' ? ctx['reference'] : '—';
      const status = typeof ctx['status'] === 'string' ? ctx['status'] : e.outcome;
      return `<tr><td>${esc(e.at)}</td><td>${esc(kind)}</td><td>${esc(reference)}</td><td>${esc(status)}</td></tr>`;
    })
    .join('');
  return `<table>
<caption>Recent receipts</caption>
<thead><tr><th scope="col">When</th><th scope="col">Kind</th><th scope="col">Reference</th><th scope="col">Status</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

/** The signed-in dashboard page for a tenant. */
function dashboardPage(
  summary: TenantSummary,
  usage: TenantUsage | null,
  charges: TenantEvent[],
  refunds: TenantEvent[],
  receipts: TenantEvent[],
): string {
  return page(
    `${summary.slug} — TenantForge portal`,
    `<header>
<h1>Account</h1>
<form method="post" action="/portal/logout"><button type="submit">Sign out</button></form>
</header>
<main>
<dl>
<dt>Account</dt><dd>${esc(summary.slug)}</dd>
<dt>Status</dt><dd>${esc(summary.status)}</dd>
<dt>Region</dt><dd>${esc(summary.region)}</dd>
<dt>Member since</dt><dd>${esc(summary.createdAt)}</dd>
${summary.planPriceUsd !== undefined ? `<dt>Plan</dt><dd>$${esc(summary.planPriceUsd)} / period</dd>` : ''}
</dl>
${usage !== null ? usageTable(usage) : ''}
${eventsTable('Recent charges', charges)}
${eventsTable('Recent refunds', refunds)}
${receiptsTable(receipts)}
</main>`,
  );
}

/**
 * Build the **tenant self-serve portal** — a customer-facing web view (distinct from the operator
 * dashboard) where a tenant sees **only its own** account, charges, and refunds. Authenticated by a
 * signed, HttpOnly, `SameSite=Strict` session cookie minted from a portal token; the tenant id comes
 * **only** from that server-side session and is never read from client input, so a tenant can never
 * reach another tenant's data (no BOLA / cross-tenant access — `std-owasp-api` API1,
 * `topic-multi-tenancy`). The server-rendered page stays read-only; the JSON `/api/*` surface adds the
 * tenant's **own-account** self-serve write actions (plan change, payment method, cancel, export,
 * erasure — ADR-0010 / threat-model B8w). Every mutation is rate-limited, CSRF-protected (a signed
 * per-session token in the {@link CSRF_HEADER} + `Origin`/`Sec-Fetch-Site` allow-list), money ops are
 * endpoint-level idempotent, and the two destructive actions (cancel, erasure) require a control-plane
 * second-factor and ship behind {@link PortalOptions.enableDestructiveActions} (OFF by default).
 *
 * A separate, **read-only** self-serve **compliance-evidence** surface (ADR-0011 Phase 3d /
 * threat-model B8e) lets a tenant list/download its **own** signed evidence bundles + the public key
 * and **self-generate** its own current bundle — behind the benign {@link PortalOptions.enableEvidence}
 * rollout flag (OFF by default), **independent** of the destructive flag. Like every other read, the
 * tenant scope is the server-derived session tenant, so a tenant reaches only its own evidence.
 *
 * @param options - The service, tenant authenticator, session secret, and optional ttl/clock/stores/flags.
 * @returns A Hono sub-app (mount it under `/portal`).
 */
export function createPortal(options: PortalOptions): Hono {
  const app = new Hono();
  const now = options.now ?? ((): number => Date.now());
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const secret = options.sessionSecret;

  /** The verified session ({ tenantId, exp }) from the cookie, or null (fail closed). */
  const sessionOf = (c: Context): Session | null => {
    const raw = getCookie(c, COOKIE);
    return raw === undefined ? null : decodeSession(raw, secret, now());
  };

  /** The tenant id from the session cookie, or null (convenience over {@link sessionOf}). */
  const session = (c: Context): string | null => sessionOf(c)?.tenantId ?? null;

  /** The current calendar month [first day 00:00 UTC, now] — the portal's usage/invoice window. */
  const currentMonth = (): { from: Date; to: Date } => {
    const d = new Date(now());
    return { from: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)), to: d };
  };

  // Sign in: exchange a portal token for a session cookie (form post), then redirect to the portal.
  app.post('/login', async (c) => {
    const body = await c.req.parseBody();
    const token = typeof body['token'] === 'string' ? body['token'] : '';
    const principal = await options.authenticator.authenticate(token);
    if (principal === null) {
      return c.html(loginPage('Invalid token.'), 401);
    }
    setCookie(c, COOKIE, encodeSession(principal.tenantId, secret, now() + ttlMs), {
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      path: '/portal',
      maxAge: Math.floor(ttlMs / 1000),
    });
    return c.redirect('/portal', 303);
  });

  // Sign out.
  app.post('/logout', (c) => {
    deleteCookie(c, COOKIE, { path: '/portal' });
    return c.redirect('/portal', 303);
  });

  // The portal home: when no SPA is built (`staticRoot` unset), serve the server-rendered no-JS page —
  // the login page when signed out, the tenant's own account page when signed in. When the SPA IS
  // built, the static handler below serves the React app at `/` instead (the SPA is the primary UI;
  // the server-rendered page remains available only when `staticRoot` is unset, e.g. JSON-API/dev).
  if (options.staticRoot === undefined) {
    app.get('/', async (c) => {
      const tenantId = session(c);
      if (tenantId === null) return c.html(loginPage());
      const summary = await options.tf.tenantSummary(tenantId);
      if (summary === null) {
        // The session names a tenant that no longer exists — clear it and show login.
        deleteCookie(c, COOKIE, { path: '/portal' });
        return c.html(loginPage('Your session has expired.'), 401);
      }
      // Usage is best-effort: if metering isn't configured (no usage provider) or the upstream is
      // down, the account page still renders — usage is just omitted, not a 500.
      const [charges, refunds, receipts, usage] = await Promise.all([
        options.tf.tenantCharges(tenantId),
        options.tf.tenantRefunds(tenantId),
        options.tf.tenantNotifications(tenantId),
        options.tf.usage(tenantId, currentMonth()).catch(() => null),
      ]);
      return c.html(dashboardPage(summary, usage, charges, refunds, receipts));
    });
  }

  /** Guard a JSON endpoint on a valid session; returns the tenant id or sends 401. */
  const requireTenant = (c: Context): string | null => {
    const tenantId = session(c);
    if (tenantId === null) {
      c.status(401);
      return null;
    }
    return tenantId;
  };

  const rateLimiter = options.rateLimitStore ?? createInMemoryRateLimitStore();
  const idem = options.idempotencyStore ?? createInMemoryIdempotencyStore();
  const allowedOrigins = options.allowedOrigins ?? [];

  // All /api/* request bodies are capped (DoS — std-owasp-api API4).
  app.use('/api/*', bodyLimit({ maxSize: MAX_BODY }));

  /** Per-(tenant|IP) fixed-window limiter; true when over the cap (429 headers set). */
  const limited = async (
    c: Context,
    bucket: string,
    key: string,
    max: number,
  ): Promise<boolean> => {
    const windowMs = 60_000;
    const { count, windowStartMs } = await rateLimiter.increment(
      `portal:${bucket}:${key}`,
      windowMs,
      now(),
    );
    if (count > max) {
      c.header('Retry-After', String(Math.ceil((windowStartMs + windowMs - now()) / 1000)));
      return true;
    }
    return false;
  };

  /** Parse a JSON body against a schema; ok with data, or a ready 400 Response. */
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

  /**
   * CSRF guard for every mutation (red-team F4): a **signed per-session token** in {@link CSRF_HEADER}
   * (not a bare double-submit a subdomain could forge), plus an `Origin`/`Sec-Fetch-Site` allow-list
   * as defense in depth. `SameSite=Strict` on the cookie is a backstop, not the control. Returns true
   * (and sends 403) when the request fails the check.
   */
  const csrfRejected = (c: Context, tenantId: string): Response | null => {
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
    // The CSRF token must verify against the LIVE session — so it's bound to this session's expiry
    // (rotates with the cookie, dies on expiry/logout — L1) and to this tenant. A session that
    // vanished mid-request (logout/expiry) fails closed here.
    const live = sessionOf(c);
    if (live === null || live.tenantId !== tenantId) {
      return c.json({ error: 'no session' }, 403);
    }
    if (!verifyCsrf(c.req.header(CSRF_HEADER), live, secret)) {
      return c.json({ error: 'missing or invalid CSRF token' }, 403);
    }
    return null;
  };

  /**
   * Wrap a mutating money handler in **endpoint-level idempotency** (red-team F3a): a client
   * `Idempotency-Key` namespaced by the session tenant reserves the operation; a replay with the same
   * key replays the original response verbatim — so the metadata write **and** the settlement **and**
   * the audit happen at most once, not just the PSP charge. A key reused with a different body is a
   * 409. No key ⇒ run normally (the action is still rate-limited + CSRF-guarded).
   */
  const withIdempotency = async (
    c: Context,
    tenantId: string,
    bodyRaw: string,
    run: () => Promise<Response>,
  ): Promise<Response> => {
    const key = c.req.header('idempotency-key');
    if (key === undefined || key === '') return run();
    const namespaced = `portal:${tenantId}:${c.req.path}:${key}`;
    const fingerprint = createHash('sha256')
      .update(`${c.req.method} ${c.req.path} ${bodyRaw}`)
      .digest('hex');
    const begun = await idem.begin(namespaced, fingerprint, now());
    if (begun.outcome === 'replay') {
      return c.body(begun.response.body, begun.response.status as 200, {
        'content-type': begun.response.contentType,
      });
    }
    if (begun.outcome === 'mismatch') {
      return c.json({ error: 'idempotency key reused with a different request' }, 409);
    }
    if (begun.outcome === 'in_flight') {
      return c.json({ error: 'a request with this idempotency key is in progress' }, 409);
    }
    const res = await run();
    // Persist the response so a retry replays it (only 2xx — a failure should be retryable).
    if (res.status >= 200 && res.status < 300) {
      const cloned = res.clone();
      const stored: IdempotentResponse = {
        status: cloned.status,
        body: await cloned.text(),
        contentType: cloned.headers.get('content-type') ?? 'application/json',
      };
      await idem.complete(namespaced, stored, now());
    }
    return res;
  };

  // Whether the destructive self-serve actions (cancel + erasure) are advertised to the SPA. Equal to
  // the feature flag (OFF by default — ADR-0010 / red-team F6); the routes themselves only exist when
  // it's true, so an SPA that respects this never renders a button that would 404. This advertises the
  // capability — it does NOT change any gating: the server still flag-gates the routes independently.
  const destructiveActions = options.enableDestructiveActions === true;
  // Whether the self-serve compliance-evidence surface is advertised (ADR-0011 Phase 3d / B8e). A
  // benign, default-OFF rollout flag — INDEPENDENT of `destructiveActions` (evidence is non-destructive).
  const evidence = options.enableEvidence === true;
  /** The advertised SPA capabilities (public; no tenant/secret) — both rollout flags. */
  const features = { destructiveActions, evidence };

  /** Mint the session cookie + return the SPA's session view (shared by both login paths). */
  const grantSession = (c: Context, tenantId: string): Response => {
    setCookie(c, COOKIE, encodeSession(tenantId, secret, now() + ttlMs), {
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      path: '/portal',
      maxAge: Math.floor(ttlMs / 1000),
    });
    return c.json({ tenantId, features });
  };

  // Public SPA config: the Stripe publishable key (public), advertised capabilities, and which login
  // mode is active (`oidc` ⇒ the SPA uses the code flow; else the dev/token form). Read before login
  // so the SPA can size its UI; exposes only public values, never the tenant or any secret.
  app.get('/api/config', (c) =>
    c.json({
      ...(options.publishableKey !== undefined ? { publishableKey: options.publishableKey } : {}),
      features,
      auth: { mode: options.codeFlow !== undefined ? 'oidc' : 'token' },
    }),
  );

  // Begin OIDC login (Authorization Code + PKCE): the SERVER generates state/nonce/code_verifier,
  // pins them in a short-TTL signed HttpOnly cookie (never handed to the SPA), and returns the IdP
  // authorize URL for the SPA to redirect to. This is what makes the callback unforgeable (H1/H2).
  app.get('/api/login/start', async (c) => {
    if (options.codeFlow === undefined) {
      return c.json({ error: 'OIDC login is not configured' }, 404);
    }
    if (await limited(c, 'login-start', clientIp(c), 20)) {
      return c.json({ error: 'too many requests' }, 429);
    }
    const flow = await options.codeFlow.start();
    setCookie(
      c,
      LOGIN_COOKIE,
      encodeLogin(
        {
          state: flow.state,
          nonce: flow.nonce,
          codeVerifier: flow.codeVerifier,
          exp: now() + LOGIN_TTL_MS,
        },
        secret,
      ),
      {
        httpOnly: true,
        secure: true,
        sameSite: 'Lax', // Lax so the cookie survives the top-level redirect back from the IdP.
        path: '/portal',
        maxAge: Math.floor(LOGIN_TTL_MS / 1000),
      },
    );
    return c.json({ authorizeUrl: flow.authorizeUrl });
  });

  // Login: mint a session cookie. Two paths (the body shape selects):
  //  - { code, state }  → OIDC Authorization Code callback: read the pinned login cookie, verify the
  //    `state` matches (login-CSRF defence), exchange code + verifier at the IdP token endpoint, and
  //    verify the id_token + its `nonce` (replay defence) — all server-side; the SPA never sees a
  //    token. The login cookie is single-use (cleared on every attempt — success OR failure).
  //  - { token }        → static/dev token path (token mode / local dev without a real IdP).
  // The tenant id is derived ONLY from the verified principal, never from request input (no BOLA).
  app.post('/api/session', async (c) => {
    if (await limited(c, 'login', clientIp(c), 20)) {
      return c.json({ error: 'too many requests' }, 429);
    }
    const parsed = await read(c, LoginSchema);
    if (!parsed.ok) return parsed.res;
    const data = parsed.data;

    if ('code' in data) {
      if (options.codeFlow === undefined) {
        return c.json({ error: 'OIDC login is not configured' }, 404);
      }
      // Read + immediately invalidate the pinned login cookie (single-use; cleared on any outcome).
      const rawLogin = getCookie(c, LOGIN_COOKIE);
      deleteCookie(c, LOGIN_COOKIE, { path: '/portal' });
      const flow = rawLogin === undefined ? null : decodeLogin(rawLogin, secret, now());
      // No started flow, or the callback's state doesn't match the pinned one → login-CSRF / replay.
      if (flow === null) return c.json({ error: 'invalid login state' }, 401);
      const got = Buffer.from(data.state);
      const want = Buffer.from(flow.state);
      if (got.length !== want.length || !timingSafeEqual(got, want)) {
        return c.json({ error: 'invalid login state' }, 401);
      }
      const principal = await options.codeFlow.exchange(data.code, flow.codeVerifier, flow.nonce);
      if (principal === null) return c.json({ error: 'login failed' }, 401);
      return grantSession(c, principal.tenantId);
    }

    // Static / dev token path.
    const principal = await options.authenticator.authenticate(data.token);
    if (principal === null) return c.json({ error: 'invalid token' }, 401);
    return grantSession(c, principal.tenantId);
  });

  // Who am I (the SPA checks this on load) — 401 without a valid session; carries the capability flags.
  app.get('/api/session', (c) => {
    const tenantId = session(c);
    return tenantId === null
      ? c.json({ error: 'not authenticated' }, 401)
      : c.json({ tenantId, features });
  });

  // Logout (SPA): clear the session cookie.
  app.delete('/api/session', (c) => {
    deleteCookie(c, COOKIE, { path: '/portal' });
    return c.body(null, 204);
  });

  // Issue the session-bound CSRF token (the SPA reads this then echoes it in the CSRF header). It is
  // minted from the live session's expiry, so it rotates with the cookie and dies on expiry/logout.
  app.get('/api/csrf', (c) => {
    const live = sessionOf(c);
    if (live === null) return c.json({ error: 'not authenticated' }, 401);
    return c.json({ csrfToken: mintCsrf(live, secret) });
  });

  // JSON endpoints (same cookie session) for automation — each strictly scoped to the session tenant.
  app.get('/api/me', async (c) => {
    const tenantId = requireTenant(c);
    if (tenantId === null) return c.json({ error: 'not authenticated' });
    const summary = await options.tf.tenantSummary(tenantId);
    return summary === null ? c.json({ error: 'not found' }, 404) : c.json(summary);
  });

  app.get('/api/charges', async (c) => {
    const tenantId = requireTenant(c);
    if (tenantId === null) return c.json({ error: 'not authenticated' });
    return c.json({ charges: await options.tf.tenantCharges(tenantId) });
  });

  app.get('/api/refunds', async (c) => {
    const tenantId = requireTenant(c);
    if (tenantId === null) return c.json({ error: 'not authenticated' });
    return c.json({ refunds: await options.tf.tenantRefunds(tenantId) });
  });

  app.get('/api/receipts', async (c) => {
    const tenantId = requireTenant(c);
    if (tenantId === null) return c.json({ error: 'not authenticated' });
    return c.json({ receipts: await options.tf.tenantNotifications(tenantId) });
  });

  app.get('/api/usage', async (c) => {
    const tenantId = requireTenant(c);
    if (tenantId === null) return c.json({ error: 'not authenticated' });
    const usage = await options.tf.usage(tenantId, currentMonth());
    // Project away the internal Neon project id — the tenant sees only its period + consumption.
    return c.json({
      tenantId: usage.tenantId,
      period: usage.period,
      consumption: usage.consumption,
    });
  });

  /** Turn a thrown facade error into a safe JSON error + status (never leaks internals). */
  const fail = (c: Context, e: unknown): Response => {
    const msg = e instanceof Error ? e.message : 'error';
    return c.json({ error: msg }, statusFor(msg) as 400);
  };

  // ---- Plan (read + preview + change) ------------------------------------------------------------

  app.get('/api/plan', async (c) => {
    const tenantId = requireTenant(c);
    if (tenantId === null) return c.json({ error: 'not authenticated' });
    const summary = await options.tf.tenantSummary(tenantId);
    if (summary === null) return c.json({ error: 'not found' }, 404);
    // Catalog is the same for all tenants (public plan list) — safe to surface; no infra ids.
    return c.json({
      current: summary.planPriceUsd ?? null,
      available: options.tf.listPlans().map((p) => ({ id: p.id, priceUsd: p.priceUsd })),
    });
  });

  app.post('/api/plan/preview', async (c) => {
    const tenantId = requireTenant(c);
    if (tenantId === null) return c.json({ error: 'not authenticated' });
    if (await limited(c, 'plan-preview', tenantId, 30)) {
      return c.json({ error: 'too many requests' }, 429);
    }
    const csrf = csrfRejected(c, tenantId);
    if (csrf !== null) return csrf; // 403 already set
    const parsed = await read(c, PlanChangeSchema);
    if (!parsed.ok) return parsed.res;
    try {
      // Pure quote — no mutation, no money. Server-derived tenant id only.
      return c.json(await options.tf.previewPlanChange(tenantId, parsed.data.newPriceUsd));
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post('/api/plan/change', async (c) => {
    const tenantId = requireTenant(c);
    if (tenantId === null) return c.json({ error: 'not authenticated' });
    if (await limited(c, 'plan-change', tenantId, 10)) {
      return c.json({ error: 'too many requests' }, 429);
    }
    const csrf = csrfRejected(c, tenantId);
    if (csrf !== null) return csrf;
    const bodyRaw = await c.req.text();
    const parsed = PlanChangeSchema.safeParse(safeJson(bodyRaw));
    if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
    // Endpoint-level idempotency wraps metadata write + settlement + audit (red-team F3a).
    return withIdempotency(c, tenantId, bodyRaw, async () => {
      try {
        const report = await options.tf.changePlan(tenantId, parsed.data.newPriceUsd, {
          settle: true,
        });
        return c.json(report);
      } catch (e) {
        return fail(c, e);
      }
    });
  });

  // ---- Payment method (setup-intent + confirm/set-default) ---------------------------------------

  app.post('/api/payment-method/setup-intent', async (c) => {
    const tenantId = requireTenant(c);
    if (tenantId === null) return c.json({ error: 'not authenticated' });
    if (await limited(c, 'pm-setup', tenantId, 10)) {
      return c.json({ error: 'too many requests' }, 429);
    }
    const csrf = csrfRejected(c, tenantId);
    if (csrf !== null) return csrf;
    try {
      // Mints a SetupIntent for THIS tenant's billingCustomerRef (fails closed if none — F5). The
      // publishable key (public) rides along so the browser can load Stripe.js with it (PAN never
      // touches this server — the card is collected + confirmed client-side via Stripe Elements).
      const setup = await options.tf.tenantPaymentSetup(tenantId);
      return c.json({
        ...setup,
        ...(options.publishableKey !== undefined ? { publishableKey: options.publishableKey } : {}),
      });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post('/api/payment-method/set-default', async (c) => {
    const tenantId = requireTenant(c);
    if (tenantId === null) return c.json({ error: 'not authenticated' });
    if (await limited(c, 'pm-default', tenantId, 10)) {
      return c.json({ error: 'too many requests' }, 429);
    }
    const csrf = csrfRejected(c, tenantId);
    if (csrf !== null) return csrf;
    const bodyRaw = await c.req.text();
    const parsed = SetDefaultSchema.safeParse(safeJson(bodyRaw));
    if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
    // Idempotent set-default: server verifies the SetupIntent + customerRef match (red-team F5).
    return withIdempotency(c, tenantId, bodyRaw, async () => {
      try {
        return c.json(
          await options.tf.confirmTenantPaymentMethod(tenantId, parsed.data.setupIntentId),
        );
      } catch (e) {
        return fail(c, e);
      }
    });
  });

  // ---- Invoices + credit balance (reads) ---------------------------------------------------------

  app.get('/api/invoices', async (c) => {
    const tenantId = requireTenant(c);
    if (tenantId === null) return c.json({ error: 'not authenticated' });
    try {
      return c.json({ invoices: await options.tf.tenantInvoices(tenantId) });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.get('/api/credit-balance', async (c) => {
    const tenantId = requireTenant(c);
    if (tenantId === null) return c.json({ error: 'not authenticated' });
    return c.json({ balanceMinor: await options.tf.creditBalance(tenantId), currency: 'usd' });
  });

  // ---- Destructive actions (feature-flagged OFF by default — ADR-0010 / red-team F6) --------------

  if (options.enableDestructiveActions === true) {
    // Step-up: request a single-use control-plane code (email) for cancel/erasure (F1).
    app.post('/api/step-up', async (c) => {
      const tenantId = requireTenant(c);
      if (tenantId === null) return c.json({ error: 'not authenticated' });
      if (await limited(c, 'step-up', tenantId, 5)) {
        return c.json({ error: 'too many requests' }, 429);
      }
      const csrf = csrfRejected(c, tenantId);
      if (csrf !== null) return csrf;
      const parsed = await read(c, z.object({ action: z.enum(['cancel', 'erasure']) }));
      if (!parsed.ok) return parsed.res;
      try {
        await options.tf.requestTenantStepUp(tenantId, parsed.data.action);
        return c.body(null, 204); // never reveal whether an email was on file (enumeration)
      } catch (e) {
        return fail(c, e);
      }
    });

    // Cancel = self-serve offboard (reversible; second-factor gated — F1). Surfaces reversibleUntil.
    app.post('/api/cancel', async (c) => {
      const tenantId = requireTenant(c);
      if (tenantId === null) return c.json({ error: 'not authenticated' });
      if (await limited(c, 'cancel', tenantId, 5)) {
        return c.json({ error: 'too many requests' }, 429);
      }
      const csrf = csrfRejected(c, tenantId);
      if (csrf !== null) return csrf;
      const parsed = await read(c, CancelSchema);
      if (!parsed.ok) return parsed.res;
      // Step-up: verify the control-plane second factor bound to `cancel` (not the OIDC token — F1).
      if (!(await options.tf.verifyTenantStepUp(tenantId, 'cancel', parsed.data.code))) {
        return c.json({ error: 'step-up verification failed' }, 403);
      }
      try {
        return c.json(await options.tf.cancelTenant(tenantId));
      } catch (e) {
        return fail(c, e);
      }
    });

    // Data export (DSAR) — rate-limited + cooldown via the per-tenant limiter.
    app.post('/api/data-export', async (c) => {
      const tenantId = requireTenant(c);
      if (tenantId === null) return c.json({ error: 'not authenticated' });
      // Tight cap = the per-tenant cooldown / max-in-flight (red-team F7).
      if (await limited(c, 'data-export', tenantId, 3)) {
        return c.json({ error: 'too many requests' }, 429);
      }
      const csrf = csrfRejected(c, tenantId);
      if (csrf !== null) return csrf;
      try {
        const result = await options.tf.exportTenantData(tenantId);
        // Safe projection: a reference to the artifact location + size; never tenant content/URIs.
        return c.json({ location: result.location, bytes: result.bytes ?? null });
      } catch (e) {
        return fail(c, e);
      }
    });

    // Erasure (irreversible) — typed confirm + second factor gate the REQUEST; the undo window guards
    // EXECUTION. The request only SCHEDULES; the tenant keeps serving until the window elapses (F2).
    app.post('/api/erasure', async (c) => {
      const tenantId = requireTenant(c);
      if (tenantId === null) return c.json({ error: 'not authenticated' });
      if (await limited(c, 'erasure', tenantId, 3)) {
        return c.json({ error: 'too many requests' }, 429);
      }
      const csrf = csrfRejected(c, tenantId);
      if (csrf !== null) return csrf;
      const parsed = await read(c, ErasureSchema);
      if (!parsed.ok) return parsed.res;
      if (!(await options.tf.verifyTenantStepUp(tenantId, 'erasure', parsed.data.code))) {
        return c.json({ error: 'step-up verification failed' }, 403);
      }
      try {
        return c.json(
          await options.tf.requestTenantErasure(
            tenantId,
            'self-serve portal erasure (GDPR Art.17)',
          ),
        );
      } catch (e) {
        return fail(c, e);
      }
    });

    // Cancel a pending erasure within the undo window (atomic pending → cancelled — F2).
    app.post('/api/erasure/cancel', async (c) => {
      const tenantId = requireTenant(c);
      if (tenantId === null) return c.json({ error: 'not authenticated' });
      if (await limited(c, 'erasure-cancel', tenantId, 10)) {
        return c.json({ error: 'too many requests' }, 429);
      }
      const csrf = csrfRejected(c, tenantId);
      if (csrf !== null) return csrf;
      try {
        const cancelled = await options.tf.cancelTenantErasure(tenantId);
        return cancelled
          ? c.json({ cancelled: true })
          : c.json({ error: 'no pending erasure to cancel' }, 409);
      } catch (e) {
        return fail(c, e);
      }
    });

    // Read the active pending erasure (undo deadline) for the SPA's danger-zone status.
    app.get('/api/erasure', async (c) => {
      const tenantId = requireTenant(c);
      if (tenantId === null) return c.json({ error: 'not authenticated' });
      return c.json({ pending: await options.tf.pendingErasure(tenantId) });
    });
  }

  // ---- Self-serve compliance evidence (ADR-0011 Phase 3d / threat-model B8e) ----------------------
  // STRICTLY SELF-SCOPED: the tenant id is the SERVER-DERIVED session tenant, passed to the store as
  // the scope on EVERY call — never `null`/fleet, never a client-supplied parameter. The store
  // (`evidenceGet`/`evidenceList`) refuses another tenant's (or a fleet) bundle under a tenant scope
  // (B10a), so a tenant can only ever list/download/generate its OWN evidence (BOLA — the project's #1
  // risk). The `:bundleId` is a non-guessable handle, NEVER a tenant selector. Behind the benign,
  // default-OFF `enableEvidence` rollout flag — INDEPENDENT of the destructive flag (this is
  // non-destructive). The public-key endpoint stays available regardless (it serves a PUBLIC key).
  if (options.enableEvidence === true) {
    // The Ed25519 PUBLIC verification key — public material only, so a valid session suffices and no
    // body/secret is exposed (the facade returns the public JWK; a private `d` is never present). 404
    // when no signer is configured (the SPA degrades gracefully). Mirrors the operator/dashboard route.
    app.get('/api/evidence/public-key', async (c) => {
      const tenantId = requireTenant(c);
      if (tenantId === null) return c.json({ error: 'not authenticated' });
      const jwk = await options.tf.evidenceBundlePublicKey();
      return jwk === null
        ? c.json({ error: 'no evidence-bundle signer is configured' }, 404)
        : c.json({ publicKey: jwk });
    });

    // List MY evidence-bundle manifests (FACTS ONLY — no JWS body). The store filter's `tenantId` is
    // the SERVER-DERIVED session tenant, so the list can only ever contain this tenant's manifests
    // (it can never enumerate another tenant's). `?limit` is validated (positive int → 400) and the
    // store clamps it (DoS bound). Empty `[]` when no evidence store is wired (fail soft).
    app.get('/api/evidence', async (c) => {
      const tenantId = requireTenant(c);
      if (tenantId === null) return c.json({ error: 'not authenticated' });
      const limitParam = c.req.query('limit');
      const limit = limitParam === undefined ? undefined : Number(limitParam);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
        return c.json({ error: 'limit must be a positive integer' }, 400);
      }
      try {
        // tenantId is the SESSION tenant — this is the BOLA defense (server-derived scope, not input).
        const manifests = await options.tf.evidenceList({
          tenantId,
          ...(limit !== undefined ? { limit } : {}),
        });
        return c.json({ manifests });
      } catch (e) {
        return fail(c, e);
      }
    });

    // Self-GENERATE my own current evidence bundle (read-only assembly + sign + persist, scoped to the
    // SESSION tenant). Non-destructive, but state-changing at the store → CSRF-protected + rate-limited
    // like every other portal mutation. Independent of the destructive flag. Fails closed (503-class)
    // when no signer is configured. NOTE: declared BEFORE `/:bundleId` so `generate` is not captured as
    // a bundle id (Hono matches in registration order).
    app.post('/api/evidence/generate', async (c) => {
      const tenantId = requireTenant(c);
      if (tenantId === null) return c.json({ error: 'not authenticated' });
      if (await limited(c, 'evidence-generate', tenantId, 5)) {
        return c.json({ error: 'too many requests' }, 429);
      }
      const csrf = csrfRejected(c, tenantId);
      if (csrf !== null) return csrf;
      try {
        // scope:'tenant' + the SERVER-DERIVED session tenant id — the bundle can only ever carry THIS
        // tenant's facts (B10 content-scoping) and is persisted under this tenant's scope (B10a).
        const result = await options.tf.evidenceBundle({ scope: 'tenant', tenantId });
        // Return the manifest (facts only) when persisted; never echo the signed body here — the SPA
        // re-fetches it via the scoped GET so there is one download path with one BOLA check.
        return c.json({ manifest: result.manifest ?? null });
      } catch (e) {
        return fail(c, e);
      }
    });

    // Download MY signed bundle (`{ bundle, jws }`) by id. The scope is the SERVER-DERIVED session
    // tenant — the store returns the bundle ONLY if it is this tenant's; another tenant's (or a fleet)
    // bundle, or an unknown/pruned id, returns null → a UNIFORM 404 (no existence oracle). The
    // `:bundleId` is a non-guessable handle, never interpreted as a tenant selector (BOLA).
    app.get('/api/evidence/:bundleId', async (c) => {
      const tenantId = requireTenant(c);
      if (tenantId === null) return c.json({ error: 'not authenticated' });
      try {
        // tenantId (session) is the scope — the second argument is set by the SERVER, never the request.
        const signed = await options.tf.evidenceGet(c.req.param('bundleId'), tenantId);
        return signed === null
          ? c.json({ error: 'not found' }, 404)
          : c.json({ bundle: signed.bundle, jws: signed.jws });
      } catch (e) {
        return fail(c, e);
      }
    });
  }

  // Serve the portal SPA when built. Scoped CSP allows Stripe.js / Elements (the strict default CSP
  // would block them); applied only on this sub-app's static routes, not the rest of the server
  // (mirrors createSignup). The `index.html` fallback lets the SPA own client-side routing.
  if (options.staticRoot !== undefined) {
    const root = options.staticRoot;
    const rewriteRequestPath = (p: string): string => p.replace(/^\/portal/, '') || '/';
    const csp: MiddlewareHandler = secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://js.stripe.com'],
        frameSrc: ['https://js.stripe.com', 'https://hooks.stripe.com'],
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

/** Parse JSON, returning `undefined` on failure (so schema parsing yields a clean 400). */
function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
