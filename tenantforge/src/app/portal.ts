import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { TenantForge, TenantSummary } from './lib.js';
import type { TenantAuthenticator } from '../ports/tenant-authenticator.js';
import type { TenantEvent, TenantUsage } from '../core/index.js';

/** Portal session cookie name (scoped to the portal path). */
const COOKIE = 'tf_portal';
/** Default portal session lifetime: 1 hour (customer-facing → shorter than the operator dashboard). */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

/** Options for {@link createPortal}. */
export interface PortalOptions {
  /** The TenantForge service the portal reads (tenant-scoped reads only). */
  tf: TenantForge;
  /** Resolves a portal token to the tenant it authenticates as. */
  authenticator: TenantAuthenticator;
  /** HMAC key signing the session cookie (a secret; required). */
  sessionSecret: string;
  /** Session lifetime in ms. Defaults to 1h. */
  ttlMs?: number;
  /** Injectable clock (ms). Defaults to `Date.now`. */
  now?: () => number;
}

/** Sign a payload with the session secret (base64url HMAC-SHA256). */
function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Encode a signed, expiring session for a tenant. */
function encodeSession(tenantId: string, secret: string, expMs: number): string {
  const body = Buffer.from(JSON.stringify({ tenantId, exp: expMs }), 'utf8').toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

/** Verify + decode a session cookie to a tenant id; null if missing/tampered/expired (fail closed). */
function decodeSession(value: string, secret: string, nowMs: number): string | null {
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
    return p.tenantId;
  } catch {
    return null;
  }
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
 * `topic-multi-tenancy`). Read-only: no money movement or lifecycle actions (those stay operator/CLI).
 * Server-rendered, semantic HTML (WCAG 2.2 AA) with no external resources.
 *
 * @param options - The service, tenant authenticator, session secret, and optional ttl/clock.
 * @returns A Hono sub-app (mount it under `/portal`).
 */
export function createPortal(options: PortalOptions): Hono {
  const app = new Hono();
  const now = options.now ?? ((): number => Date.now());
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const secret = options.sessionSecret;

  /** The tenant id from the session cookie, or null. */
  const session = (c: Context): string | null => {
    const raw = getCookie(c, COOKIE);
    return raw === undefined ? null : decodeSession(raw, secret, now());
  };

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

  // The portal home: the login page when signed out, the tenant's own account page when signed in.
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

  /** Guard a JSON endpoint on a valid session; returns the tenant id or sends 401. */
  const requireTenant = (c: Context): string | null => {
    const tenantId = session(c);
    if (tenantId === null) {
      c.status(401);
      return null;
    }
    return tenantId;
  };

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

  return app;
}
