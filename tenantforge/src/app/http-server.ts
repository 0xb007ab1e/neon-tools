import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { HTTPException } from 'hono/http-exception';
import type { Context, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { TENANTFORGE } from '../meta.js';
import type { JsonObject, TenantStatus } from '../core/index.js';
import { decodeCursor, encodeCursor, can, type Permission } from '../core/index.js';
import type { RateLimitStore } from '../ports/rate-limit-store.js';
import { createInMemoryRateLimitStore } from '../adapters/rate-limit-store.js';
import type { IdempotencyStore } from '../ports/idempotency-store.js';
import { createInMemoryIdempotencyStore } from '../adapters/idempotency-store.js';
import type { Authenticator, HttpCredential, Principal } from '../ports/authenticator.js';
import { createTokenAuthenticator } from '../adapters/auth/token-authenticator.js';
import type { TenantForge } from './lib.js';
import { runWithActor } from './actor-context.js';
import { createDashboard } from './dashboard.js';
import { createPortal } from './portal.js';
import type { TenantAuthenticator } from '../ports/tenant-authenticator.js';

// Re-export the auth types so existing importers (config) keep their import path.
export type { HttpRole, HttpCredential, Principal, Authenticator } from '../ports/authenticator.js';

/** Fixed-window rate-limit settings (per principal). */
export interface RateLimitOptions {
  /** Max requests per window. */
  limit: number;
  /** Window length in ms. */
  windowMs: number;
}

/** Options for {@link createHttpServer}. */
export interface HttpServerOptions {
  /** Admin-token shorthand for a single-operator deploy (≡ one `admin` credential). */
  token?: string;
  /** Per-operator credentials (preferred over `token`): attributable identity + role. */
  credentials?: HttpCredential[];
  /** Authenticator to resolve the bearer token (e.g. OIDC). Defaults to a token authenticator. */
  authenticator?: Authenticator;
  /** Per-principal rate limit. Defaults to 120 requests / 60s. */
  rateLimit?: RateLimitOptions;
  /** Counter store for the rate limiter. Defaults to in-memory (per-instance). */
  rateLimitStore?: RateLimitStore;
  /** Store for HTTP idempotency keys (replay POST retries). Defaults to in-memory (per-instance). */
  idempotencyStore?: IdempotencyStore;
  /** When set, mount the cookie-session **dashboard** backend at `/dashboard` (HMAC session key). */
  dashboardSecret?: string;
  /** Path to the built SPA (`dashboard/dist`); when set, the dashboard also serves the front-end. */
  dashboardStaticRoot?: string;
  /** Migration SQL catalog; when set, the dashboard can EXECUTE a reconcile (tenant:provision-gated). */
  dashboardReconcileCatalog?: readonly import('../adapters/fleet-orchestrator.js').FleetMigrationSpec[];
  /** When set (with a tenant authenticator), mount the customer-facing **self-serve portal** at `/portal`. */
  portalSecret?: string;
  /** Resolves a portal token to a tenant; required to mount the portal. */
  tenantAuthenticator?: TenantAuthenticator;
  /** Injectable clock (ms) for rate limiting — defaults to `Date.now`. */
  now?: () => number;
  /**
   * When set, mount an unauthenticated `GET /metrics` returning this Prometheus text (e.g. a
   * {@link import('../adapters/metrics-event-sink.js').MetricsEventSink}'s `render`). Omitted = no
   * metrics endpoint.
   */
  metrics?: () => string;
  /**
   * When true, mount the inbound PSP webhook endpoint `POST /webhooks/payment` — authenticated by the
   * PSP **signature** (not the bearer token), so it sits outside the `/v1/*` auth. Enable only when a
   * webhook verifier is configured on the service.
   */
  paymentWebhooks?: boolean;
}

/** Hono Variables: the resolved principal, set by the auth middleware. */
type Env = { Variables: { principal: Principal } };

const TENANT_STATUSES = ['provisioning', 'active', 'suspended', 'offboarding', 'deleted'] as const;

const ProvisionSchema = z.object({
  slug: z.string().min(1),
  region: z.string().min(1).optional(),
  residency: z.enum(['us', 'eu', 'apac']).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const PurgeSchema = z.object({
  // Defense in depth: the irreversible hard-delete must be explicitly confirmed in the body.
  confirm: z.literal(true),
});

/** Parse `?from`/`?to` into a period (default: current calendar month → now); null on a bad date. */
function invoicePeriod(c: Context<Env>, now: () => number): { from: Date; to: Date } | null {
  const t = new Date(now());
  const fromParam = c.req.query('from');
  const toParam = c.req.query('to');
  const from =
    fromParam !== undefined ? new Date(fromParam) : new Date(t.getFullYear(), t.getMonth(), 1);
  const to = toParam !== undefined ? new Date(toParam) : t;
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return { from, to };
}

/** Return an RFC 9457 problem+json response. */
function problem(c: Context<Env>, status: number, title: string, detail?: string) {
  return c.json(
    { type: 'about:blank', title, status, ...(detail !== undefined ? { detail } : {}) },
    status as 400,
    { 'content-type': 'application/problem+json' },
  );
}

/** Map a use-case error to a safe HTTP status; unexpected errors become a generic 500. */
function handleError(c: Context<Env>, error: unknown) {
  const message = error instanceof Error ? error.message : 'error';
  if (/not found/.test(message)) return problem(c, 404, 'Not Found', message);
  if (/invalid tenant slug|unknown region|requires a reason/.test(message)) {
    return problem(c, 400, 'Bad Request', message);
  }
  if (/illegal tenant status transition|belongs to a|no exporter configured/.test(message)) {
    return problem(c, 409, 'Conflict', message);
  }
  // Unexpected (e.g. Neon API / registry failure): log server-side, never leak internals.
  process.stderr.write(`tenantforge http: ${message}\n`);
  return problem(c, 500, 'Internal Server Error');
}

/** Parse + validate a JSON body against a schema, returning a 400 problem on failure. */
async function readJson<T>(
  c: Context<Env>,
  schema: z.ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; res: Response }> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, res: problem(c, 400, 'Invalid JSON body') };
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { ok: false, res: problem(c, 400, 'Validation failed', detail) };
  }
  return { ok: true, data: result.data };
}

/**
 * Build the TenantForge HTTP control-plane API (a Hono app): provision, list, get, and the
 * lifecycle operations (suspend / resume / offboard). Every `/v1/*` route requires a bearer token
 * and a bounded body; the {@link TenantForge} service is injected so the app is testable without
 * infrastructure.
 *
 * The tenant id in a path is the server's own identifier — authorization is the bearer token; a
 * production deployment derives the tenant scope from the authenticated principal, never trusting a
 * client-supplied id beyond this single-tenant-admin token model (std-owasp-api BOLA).
 *
 * @param tf - The TenantForge application service.
 * @param options - The bearer token to require.
 * @returns A configured Hono app (use its `.fetch` with a server, or `.request` in tests).
 */
export function createHttpServer(tf: TenantForge, options: HttpServerOptions): Hono<Env> {
  const app = new Hono<Env>();

  // Resolve the authenticator: an injected one (e.g. OIDC) wins; else build a token authenticator
  // from the credential list / admin-token shorthand. Fail closed if there is no way to authenticate.
  let authenticator: Authenticator;
  if (options.authenticator !== undefined) {
    authenticator = options.authenticator;
  } else {
    const credentials: HttpCredential[] =
      options.credentials ??
      (options.token !== undefined ? [{ id: 'default', token: options.token, role: 'admin' }] : []);
    if (credentials.length === 0) {
      throw new Error('createHttpServer: an authenticator, credentials, or a token is required');
    }
    authenticator = createTokenAuthenticator(credentials);
  }
  const rateLimit = options.rateLimit ?? { limit: 120, windowMs: 60_000 };
  const now = options.now ?? ((): number => Date.now());
  const rateLimitStore = options.rateLimitStore ?? createInMemoryRateLimitStore();
  const idempotencyStore = options.idempotencyStore ?? createInMemoryIdempotencyStore();

  app.use('*', secureHeaders());

  // Dashboard backend (cookie-session auth, its own routes) — mounted only when a session key is set.
  if (options.dashboardSecret !== undefined) {
    app.route(
      '/dashboard',
      createDashboard({
        tf,
        authenticator,
        sessionSecret: options.dashboardSecret,
        now: () => now(),
        ...(options.dashboardStaticRoot !== undefined
          ? { staticRoot: options.dashboardStaticRoot }
          : {}),
        ...(options.dashboardReconcileCatalog !== undefined
          ? { reconcileCatalog: options.dashboardReconcileCatalog }
          : {}),
      }),
    );
  }

  // Tenant self-serve portal (customer-facing, its own cookie session) — mounted only when a portal
  // session key + a tenant authenticator are both configured.
  if (options.portalSecret !== undefined && options.tenantAuthenticator !== undefined) {
    app.route(
      '/portal',
      createPortal({
        tf,
        authenticator: options.tenantAuthenticator,
        sessionSecret: options.portalSecret,
        now: () => now(),
      }),
    );
  }

  // Liveness: the process is up (static — no dependency checks).
  app.get('/health', (c) =>
    c.json({ status: 'ok', tool: TENANTFORGE.id, version: TENANTFORGE.version }),
  );

  // Readiness: probe critical dependencies (registry connectivity). 503 when degraded so an
  // orchestrator stops routing traffic to an instance that can't serve (topic-reliability).
  app.get('/ready', async (c) => {
    const report = await tf.health();
    return c.json(report, report.status === 'ok' ? 200 : 503);
  });

  // Prometheus scrape endpoint (text exposition), unauthenticated like the probes; only when wired.
  if (options.metrics !== undefined) {
    const renderMetrics = options.metrics;
    app.get('/metrics', (c) =>
      c.text(renderMetrics(), 200, { 'content-type': 'text/plain; version=0.0.4' }),
    );
  }

  // Inbound PSP webhook endpoint — authenticated by the **signature** (not the bearer token), so it
  // is deliberately OUTSIDE the /v1 auth. Verification uses the RAW request body; we read it as text
  // and never re-serialize. Body-size-capped. Respond 2xx fast on success, 400 on a bad/stale
  // signature or malformed payload (never leaking why).
  if (options.paymentWebhooks === true) {
    app.post('/webhooks/payment', bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
      const signature = c.req.header('stripe-signature') ?? '';
      const rawBody = await c.req.text();
      try {
        const event = await tf.ingestPaymentWebhook(rawBody, signature);
        return c.json({ received: true, type: event.type });
      } catch {
        // Untrusted input: a verification/parse failure is a 400; do not echo details.
        return problem(c, 400, 'Bad Request', 'invalid webhook signature or payload');
      }
    });
  }

  // AuthN: resolve the bearer token to a principal via the authenticator (token match or OIDC JWT).
  const authenticate: MiddlewareHandler<Env> = async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    const principal = await authenticator.authenticate(presented);
    if (principal === null) return problem(c, 401, 'Unauthorized');
    c.set('principal', principal);
    // Carry the operator identity through the request so every emitted event is attributed
    // (who-did-what-when). Downstream handlers + facade calls run within this context.
    return runWithActor({ id: principal.id, role: principal.role }, () => next());
  };

  // Per-principal fixed-window rate limit, counted via the injected store (in-memory by default; a
  // Postgres-backed store makes the limit global across instances — threat-model R2).
  const rateLimiter: MiddlewareHandler<Env> = async (c, next) => {
    const t = now();
    const { count, windowStartMs } = await rateLimitStore.increment(
      c.get('principal').id,
      rateLimit.windowMs,
      t,
    );
    if (count > rateLimit.limit) {
      c.header('Retry-After', String(Math.ceil((windowStartMs + rateLimit.windowMs - t) / 1000)));
      return problem(c, 429, 'Too Many Requests');
    }
    return next();
  };

  // Idempotency: a client may set `Idempotency-Key` on a POST so a retry replays the original
  // response instead of re-executing (topic-api-design / topic-reliability). The key is namespaced
  // by principal so operators can't collide. A server error (5xx) is stored too — a genuine retry
  // after one should use a fresh key. Runs after the body-size cap so we never hash an oversized body.
  const idempotency: MiddlewareHandler<Env> = async (c, next) => {
    const presented = c.req.header('Idempotency-Key');
    if (c.req.method !== 'POST' || presented === undefined || presented === '') return next();
    if (presented.length > 255) return problem(c, 400, 'Bad Request', 'Idempotency-Key too long');

    const rawBody = await c.req.raw.clone().text();
    const fingerprint = createHash('sha256')
      .update(`${c.req.method}\n${c.req.path}\n${rawBody}`)
      .digest('hex');
    const key = `${c.get('principal').id}:${presented}`;

    const begun = await idempotencyStore.begin(key, fingerprint, now());
    if (begun.outcome === 'replay') {
      return new Response(begun.response.body, {
        status: begun.response.status,
        headers: { 'content-type': begun.response.contentType, 'Idempotency-Replayed': 'true' },
      });
    }
    if (begun.outcome === 'in_flight') {
      return problem(c, 409, 'Conflict', 'a request with this Idempotency-Key is in progress');
    }
    if (begun.outcome === 'mismatch') {
      return problem(
        c,
        422,
        'Unprocessable Entity',
        'Idempotency-Key reused with a different request',
      );
    }

    await next();
    const captured = c.res.clone();
    await idempotencyStore.complete(
      key,
      {
        status: captured.status,
        body: await captured.text(),
        contentType: captured.headers.get('content-type') ?? 'application/json',
      },
      now(),
    );
  };

  app.use('/v1/*', authenticate);
  app.use('/v1/*', rateLimiter);
  app.use('/v1/*', bodyLimit({ maxSize: 1024 * 1024 }));
  app.use('/v1/*', idempotency);

  // AuthZ: each route requires a specific permission, evaluated server-side against the principal's
  // role/permissions; deny by default (std-owasp-api API5 Broken Function Level Authorization,
  // topic-authn-authz). `admin` holds all; `operator` all but `tenant:purge`; `readonly` only reads.
  const requirePermission =
    (permission: Permission): MiddlewareHandler<Env> =>
    (c, next) => {
      if (!can(c.get('principal'), permission)) {
        return Promise.resolve(problem(c, 403, 'Forbidden', `requires ${permission}`));
      }
      return next();
    };

  app.post('/v1/tenants', requirePermission('tenant:provision'), async (c) => {
    const parsed = await readJson(c, ProvisionSchema);
    if (!parsed.ok) return parsed.res;
    const { slug, region, residency, metadata } = parsed.data;
    try {
      const outcome = await tf.provision({
        slug,
        ...(region !== undefined ? { region } : {}),
        ...(residency !== undefined ? { residency } : {}),
        ...(metadata !== undefined ? { metadata: metadata as JsonObject } : {}),
      });
      // connectionUri is a secret delivered once to the authenticated caller; never logged.
      return c.json({ tenant: outcome.tenant, connectionUri: outcome.connectionUri }, 201);
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.get('/v1/tenants', requirePermission('tenant:read'), async (c) => {
    const statusParam = c.req.query('status');
    if (statusParam !== undefined && !TENANT_STATUSES.includes(statusParam as TenantStatus)) {
      return problem(c, 400, 'Bad Request', `unknown status "${statusParam}"`);
    }
    const limitParam = c.req.query('limit');
    const limit = limitParam === undefined ? undefined : Number(limitParam);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      return problem(c, 400, 'Bad Request', 'limit must be a positive integer');
    }
    const cursorParam = c.req.query('cursor');
    const cursor = cursorParam === undefined ? null : decodeCursor(cursorParam);
    if (cursorParam !== undefined && cursor === null) {
      return problem(c, 400, 'Bad Request', 'invalid cursor');
    }
    const effectiveLimit = limit ?? 100;
    try {
      const tenants = await tf.listTenants({
        ...(statusParam !== undefined ? { status: statusParam as TenantStatus } : {}),
        limit: effectiveLimit,
        ...(cursor !== null ? { cursor } : {}),
      });
      // Keyset next-page token: present only when this page is full (more may remain).
      const last = tenants[tenants.length - 1];
      const nextCursor =
        tenants.length === effectiveLimit && last !== undefined
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null;
      return c.json({ tenants, nextCursor });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.get('/v1/tenants/:id', requirePermission('tenant:read'), async (c) => {
    try {
      const tenant = await tf.getTenant(c.req.param('id'));
      if (!tenant) return problem(c, 404, 'Not Found');
      return c.json({ tenant });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.get('/v1/compliance/report', requirePermission('tenant:read'), async (c) => {
    try {
      const { report, digest } = await tf.complianceReport();
      return c.json({ report, digest });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.get('/v1/cost/report', requirePermission('tenant:read'), async (c) => {
    // Default to the current calendar month; allow ?from / ?to ISO overrides.
    const t = new Date(now());
    const fromParam = c.req.query('from');
    const toParam = c.req.query('to');
    const from =
      fromParam !== undefined ? new Date(fromParam) : new Date(t.getFullYear(), t.getMonth(), 1);
    const to = toParam !== undefined ? new Date(toParam) : t;
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return problem(c, 400, 'Bad Request', 'from/to must be ISO-8601 dates');
    }
    try {
      return c.json(await tf.costReport({ from, to }));
    } catch (error) {
      return handleError(c, error);
    }
  });

  // Fleet invoices for a period (?from/?to ISO; default current month). Read-only document generation.
  app.get('/v1/invoices', requirePermission('tenant:read'), async (c) => {
    const period = invoicePeriod(c, now);
    if (period === null) return problem(c, 400, 'Bad Request', 'from/to must be ISO-8601 dates');
    try {
      return c.json(await tf.invoiceFleet(period));
    } catch (error) {
      return handleError(c, error);
    }
  });

  // A single tenant's invoice for a period.
  app.get('/v1/tenants/:id/invoice', requirePermission('tenant:read'), async (c) => {
    const period = invoicePeriod(c, now);
    if (period === null) return problem(c, 400, 'Bad Request', 'from/to must be ISO-8601 dates');
    try {
      return c.json(await tf.invoice(c.req.param('id'), period));
    } catch (error) {
      return handleError(c, error);
    }
  });

  // Plan-change PREVIEW (read-only quote — prorated delta for switching to ?price). Applying a plan
  // change (and settling money) is a library/CLI op (gated), not HTTP.
  app.get('/v1/tenants/:id/plan/preview', requirePermission('tenant:read'), async (c) => {
    const price = Number(c.req.query('price'));
    if (!Number.isFinite(price) || price < 0) {
      return problem(c, 400, 'Bad Request', 'price (USD, >= 0) is required');
    }
    const period = invoicePeriod(c, now);
    if (period === null) return problem(c, 400, 'Bad Request', 'from/to must be ISO-8601 dates');
    try {
      return c.json(await tf.previewPlanChange(c.req.param('id'), price, { period }));
    } catch (error) {
      return handleError(c, error);
    }
  });

  // A tenant's credit balance + ledger (read-only). Granting credit is a CLI op (gated liability).
  app.get('/v1/tenants/:id/credit', requirePermission('tenant:read'), async (c) => {
    const currency = c.req.query('currency') ?? 'usd';
    const limitParam = c.req.query('limit');
    const limit = limitParam === undefined ? undefined : Number(limitParam);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      return problem(c, 400, 'Bad Request', 'limit must be a positive integer');
    }
    try {
      const id = c.req.param('id');
      const [balanceMinor, entries] = await Promise.all([
        tf.creditBalance(id, currency),
        tf.creditHistory(id, limit),
      ]);
      return c.json({ tenantId: id, currency: currency.toLowerCase(), balanceMinor, entries });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // Recent plan-change events (read-only). Applying a change is a CLI op (mutation + optional money).
  app.get('/v1/billing/plan-changes', requirePermission('tenant:read'), async (c) => {
    const limitParam = c.req.query('limit');
    const limit = limitParam === undefined ? undefined : Number(limitParam);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      return problem(c, 400, 'Bad Request', 'limit must be a positive integer');
    }
    try {
      return c.json({ planChanges: await tf.planChangeHistory(limit) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // Fleet reconcile PLAN (read-only preview — which tenants are behind + what they'd receive).
  // Execution needs the migration SQL catalog, so it stays a library/CLI operation, not HTTP.
  app.get('/v1/fleet/reconcile', requirePermission('tenant:read'), async (c) => {
    const targetVersion = c.req.query('target');
    try {
      return c.json(
        await tf.reconcilePlan(targetVersion !== undefined ? { targetVersion } : undefined),
      );
    } catch (error) {
      return handleError(c, error);
    }
  });

  // Recent fleet reconcile/migration history (from the persisted audit trail; [] without one).
  app.get('/v1/fleet/reconcile/history', requirePermission('tenant:read'), async (c) => {
    const limitParam = c.req.query('limit');
    const limit = limitParam === undefined ? undefined : Number(limitParam);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      return problem(c, 400, 'Bad Request', 'limit must be a positive integer');
    }
    try {
      return c.json({ history: await tf.reconcileHistory(limit) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // Recent charge history (read-only). Charging itself is money movement — a CLI/gated op, never HTTP.
  app.get('/v1/billing/charges', requirePermission('tenant:read'), async (c) => {
    const limitParam = c.req.query('limit');
    const limit = limitParam === undefined ? undefined : Number(limitParam);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      return problem(c, 400, 'Bad Request', 'limit must be a positive integer');
    }
    try {
      return c.json({ charges: await tf.chargeHistory(limit) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // Recent inbound payment-webhook events (read-only).
  app.get('/v1/billing/webhook-events', requirePermission('tenant:read'), async (c) => {
    const limitParam = c.req.query('limit');
    const limit = limitParam === undefined ? undefined : Number(limitParam);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      return problem(c, 400, 'Bad Request', 'limit must be a positive integer');
    }
    try {
      return c.json({ events: await tf.paymentWebhookHistory(limit) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // Recent billing-receipt notifications (read-only). Receipts are an automatic best-effort
  // side-effect of charge/refund; the recipient address is never recorded.
  app.get('/v1/billing/notifications', requirePermission('tenant:read'), async (c) => {
    const limitParam = c.req.query('limit');
    const limit = limitParam === undefined ? undefined : Number(limitParam);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      return problem(c, 400, 'Bad Request', 'limit must be a positive integer');
    }
    try {
      return c.json({ notifications: await tf.notificationHistory(limit) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // Recent refund events (read-only). Issuing a refund returns real money, so it is CLI-only +
  // --yes gated — never exposed over HTTP.
  app.get('/v1/billing/refunds', requirePermission('tenant:read'), async (c) => {
    const limitParam = c.req.query('limit');
    const limit = limitParam === undefined ? undefined : Number(limitParam);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      return problem(c, 400, 'Bad Request', 'limit must be a positive integer');
    }
    try {
      return c.json({ refunds: await tf.refundHistory(limit) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // Recent billing-run roll-up events (read-only). The run itself charges the fleet + may suspend,
  // so it is CLI-only + --yes gated (for a cron) — never exposed over HTTP.
  app.get('/v1/billing/runs', requirePermission('tenant:read'), async (c) => {
    const limitParam = c.req.query('limit');
    const limit = limitParam === undefined ? undefined : Number(limitParam);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      return problem(c, 400, 'Bad Request', 'limit must be a positive integer');
    }
    try {
      return c.json({ runs: await tf.billingRunHistory(limit) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // Recent dunning (failed-charge retry) events (read-only). The dunning *run* itself moves money
  // and may suspend tenants, so it is CLI-only + --yes gated — never exposed over HTTP.
  app.get('/v1/billing/dunning', requirePermission('tenant:read'), async (c) => {
    const limitParam = c.req.query('limit');
    const limit = limitParam === undefined ? undefined : Number(limitParam);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      return problem(c, 400, 'Bad Request', 'limit must be a positive integer');
    }
    try {
      return c.json({ events: await tf.dunningHistory(limit) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.post('/v1/tenants/:id/suspend', requirePermission('tenant:suspend'), async (c) => {
    try {
      return c.json({ tenant: await tf.suspend(c.req.param('id')) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.post('/v1/tenants/:id/resume', requirePermission('tenant:suspend'), async (c) => {
    try {
      return c.json({ tenant: await tf.resume(c.req.param('id')) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.post('/v1/tenants/:id/offboard', requirePermission('tenant:offboard'), async (c) => {
    // Reversible: archives (retains, scaled to zero) — no confirmation needed.
    try {
      const outcome = await tf.offboard(c.req.param('id'));
      return c.json({ tenant: outcome.tenant, archive: outcome.archive });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.post('/v1/tenants/:id/purge', requirePermission('tenant:purge'), async (c) => {
    const parsed = await readJson(c, PurgeSchema);
    if (!parsed.ok) return parsed.res;
    try {
      return c.json({ tenant: await tf.purge(c.req.param('id')) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.notFound((c) => problem(c, 404, 'Not Found'));
  app.onError((error, c) => {
    // Preserve framework HTTP errors (e.g. bearerAuth 401, bodyLimit 413).
    if (error instanceof HTTPException) return error.getResponse();
    return handleError(c, error);
  });

  return app;
}
