import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import type { TenantForge, TenantSummary } from '../../src/app/lib.js';
import type { TenantAuthenticator } from '../../src/ports/tenant-authenticator.js';
import type { OidcCodeFlow } from '../../src/ports/oidc-code-flow.js';
import { createPortal } from '../../src/app/portal.js';

const SECRET = 'portal-contract-secret-0123456789';

/**
 * Unauthenticated operations — they MUST NOT require a portal session (the SPA hits them before
 * login). The "every mutation requires a session" assertion excludes these by design: `/api/config`
 * is public; `POST /api/session` + `GET /api/login/start` are the login surface itself; `DELETE
 * /api/session` is logout (clears the cookie, 204 either way).
 */
const PUBLIC_OPERATIONS = new Set([
  'get /api/config',
  'get /api/login/start',
  'get /api/session',
  'post /api/session',
  'delete /api/session',
]);

/** A stub OIDC code flow so the documented `/api/login/start` + code-callback routes exist (route, not behavior). */
const codeFlow: OidcCodeFlow = {
  start: () =>
    Promise.resolve({
      authorizeUrl: 'https://idp.example.com/authorize?state=s',
      state: 's',
      nonce: 'n',
      codeVerifier: 'v',
    }),
  exchange: () => Promise.resolve({ tenantId: 't-a' }),
};

/** Permissive TenantForge so every documented portal route resolves (assert routing, not behavior). */
const permissiveTf = (): TenantForge =>
  ({
    tenantSummary: (id: string): Promise<TenantSummary> =>
      Promise.resolve({
        id,
        slug: 'acme',
        region: 'aws-us-east-1',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        planPriceUsd: 9,
      }),
    tenantCharges: () => Promise.resolve([]),
    tenantRefunds: () => Promise.resolve([]),
    tenantNotifications: () => Promise.resolve([]),
    usage: (id: string) =>
      Promise.resolve({
        tenantId: id,
        neonProjectId: 'p',
        period: { from: 'x', to: 'y' },
        consumption: {
          computeTimeSeconds: 0,
          activeTimeSeconds: 0,
          writtenDataBytes: 0,
          syntheticStorageBytes: 0,
        },
      }),
    listPlans: () => [{ id: 'pro', priceUsd: 29 }],
    previewPlanChange: (id: string, p: number) =>
      Promise.resolve({
        tenantId: id,
        oldPriceUsd: 0,
        newPriceUsd: p,
        period: { from: 'x', to: 'y' },
        proratedDeltaMinor: 0,
      }),
    changePlan: (id: string, p: number) =>
      Promise.resolve({
        tenantId: id,
        oldPriceUsd: 0,
        newPriceUsd: p,
        period: { from: 'x', to: 'y' },
        proratedDeltaMinor: 0,
        settlement: 'none' as const,
      }),
    tenantPaymentSetup: () => Promise.resolve({ clientSecret: 'cs', setupIntentId: 'si' }),
    confirmTenantPaymentMethod: (id: string, setupIntentId: string) =>
      Promise.resolve({ tenantId: id, hasDefault: true as const, setupIntentId }),
    tenantInvoices: () => Promise.resolve([]),
    creditBalance: () => Promise.resolve(0),
    requestTenantStepUp: () => Promise.resolve(),
    verifyTenantStepUp: () => Promise.resolve(true),
    cancelTenant: (id: string) =>
      Promise.resolve({ tenantId: id, status: 'offboarding', reversibleUntil: 'x' }),
    exportTenantData: () => Promise.resolve({ location: 'archive://x', bytes: 1 }),
    requestTenantErasure: (id: string) =>
      Promise.resolve({
        tenantId: id,
        requestedAt: 'x',
        executeAt: 'y',
        status: 'pending' as const,
      }),
    cancelTenantErasure: () => Promise.resolve(true),
    pendingErasure: () => Promise.resolve(null),
  }) as unknown as TenantForge;

const auth: TenantAuthenticator = {
  authenticate: (t: string) => Promise.resolve(t === 'tok-a' ? { tenantId: 't-a' } : null),
};

interface OpenApiDoc {
  paths: Record<string, Record<string, unknown>>;
}
const spec = parse(
  readFileSync(fileURLToPath(new URL('../../openapi.portal.yaml', import.meta.url)), 'utf8'),
) as OpenApiDoc;
const operations = Object.entries(spec.paths).flatMap(([path, methods]) =>
  Object.keys(methods)
    .filter((m) => ['get', 'post', 'delete'].includes(m))
    .map((method) => ({ path, method })),
);

/** Build a portal sub-app routing the FULL surface (destructive flag on, OIDC code flow wired). */
const fullPortal = (): ReturnType<typeof createPortal> =>
  createPortal({
    tf: permissiveTf(),
    authenticator: auth,
    codeFlow,
    sessionSecret: SECRET,
    enableDestructiveActions: true, // document the full surface, so route the full surface
  });

/**
 * Probe a path/method against a Hono app WITHOUT going through the router's `request()` matcher being
 * fooled — Hono returns 404 for an unrouted path and 405 for a routed path with the wrong method.
 * Returns the raw status so the caller can assert routed-ness.
 */
async function probe(
  app: ReturnType<typeof createPortal>,
  path: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<number> {
  const res = await app.request(`/api${path.replace('/api', '')}`, {
    method: method.toUpperCase(),
    headers,
    ...(body !== undefined ? { body } : {}),
  });
  return res.status;
}

/** Log in, then read the live session-bound CSRF token from /api/csrf (the real client flow). */
async function loggedIn(
  app: ReturnType<typeof createPortal>,
): Promise<{ cookie: string; csrf: string }> {
  const res = await app.request('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: 'tok-a' }).toString(),
  });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
  const csrf = (
    (await (await app.request('/api/csrf', { headers: { cookie } })).json()) as {
      csrfToken: string;
    }
  ).csrfToken;
  return { cookie, csrf };
}

/**
 * The portal's full routed `/api/*` surface (method + path), independent of the OpenAPI doc — the
 * ground truth the contract is checked against in BOTH directions. Kept in sync deliberately: a new
 * route added to `createPortal` must be added here AND documented, or the parity test fails. This is
 * the route inventory that catches shadow/zombie endpoints (OWASP API9). The body-only `POST` routes
 * `/api/plan/preview` etc. and the read `GET`s are all included; `login/start` + the session
 * GET/POST/DELETE are the auth surface.
 */
const ROUTED_OPERATIONS: { path: string; method: string }[] = [
  { path: '/api/config', method: 'get' },
  { path: '/api/login/start', method: 'get' },
  { path: '/api/session', method: 'get' },
  { path: '/api/session', method: 'post' },
  { path: '/api/session', method: 'delete' },
  { path: '/api/csrf', method: 'get' },
  { path: '/api/me', method: 'get' },
  { path: '/api/usage', method: 'get' },
  { path: '/api/charges', method: 'get' },
  { path: '/api/refunds', method: 'get' },
  { path: '/api/receipts', method: 'get' },
  { path: '/api/plan', method: 'get' },
  { path: '/api/plan/preview', method: 'post' },
  { path: '/api/plan/change', method: 'post' },
  { path: '/api/payment-method/setup-intent', method: 'post' },
  { path: '/api/payment-method/set-default', method: 'post' },
  { path: '/api/invoices', method: 'get' },
  { path: '/api/credit-balance', method: 'get' },
  // destructive (flag-gated)
  { path: '/api/step-up', method: 'post' },
  { path: '/api/cancel', method: 'post' },
  { path: '/api/data-export', method: 'post' },
  { path: '/api/erasure', method: 'get' },
  { path: '/api/erasure', method: 'post' },
  { path: '/api/erasure/cancel', method: 'post' },
];

describe('Portal OpenAPI contract ↔ sub-app', () => {
  it('documents the full surface (reads + session + money + destructive)', () => {
    expect(operations.length).toBeGreaterThanOrEqual(ROUTED_OPERATIONS.length);
  });

  it.each(operations)('serves $method $path (documented → routed)', async ({ path, method }) => {
    const app = fullPortal();
    const { cookie, csrf } = await loggedIn(app);
    const body: Record<string, unknown> = {
      newPriceUsd: 1,
      setupIntentId: 'si',
      action: 'cancel',
      code: '123456',
      confirm: 'ERASE',
      token: 'tok-a',
    };
    const sendBody = method === 'post' ? JSON.stringify(body) : undefined;
    const status = await probe(
      app,
      path,
      method,
      {
        cookie,
        'content-type': 'application/json',
        'x-tf-csrf': csrf,
        'sec-fetch-site': 'same-origin',
      },
      sendBody,
    );
    // The route exists (not a 404/405 from the router). Behavior is asserted elsewhere.
    // (`/api/login/start` 404s only when `codeFlow` is unset — here it's wired, so it routes.)
    expect(status, `${method} ${path} should be routed`).not.toBe(404);
    expect(status, `${method} ${path} should accept this method`).not.toBe(405);
  });

  it('documents every routed endpoint (routed → documented; no shadow/zombie endpoints — API9)', () => {
    const documented = new Set(operations.map((o) => `${o.method} ${o.path}`));
    const undocumented = ROUTED_OPERATIONS.filter(
      (o) => !documented.has(`${o.method} ${o.path}`),
    ).map((o) => `${o.method} ${o.path}`);
    expect(undocumented, 'routed but undocumented').toEqual([]);
  });

  it('routes nothing the spec does not document (documented → routed; no dead doc entries)', () => {
    const routed = new Set(ROUTED_OPERATIONS.map((o) => `${o.method} ${o.path}`));
    const orphanDocs = operations.map((o) => `${o.method} ${o.path}`).filter((k) => !routed.has(k));
    expect(orphanDocs, 'documented but not routed').toEqual([]);
  });

  it('every session-protected operation rejects a missing session (cookie-session auth required)', async () => {
    const app = fullPortal();
    // Only the non-public operations: the unauthenticated login/config/logout surface is excluded
    // by design (it's hit before there is a session).
    const protectedOps = operations.filter((o) => !PUBLIC_OPERATIONS.has(`${o.method} ${o.path}`));
    expect(protectedOps.length).toBeGreaterThan(0);
    for (const { path, method } of protectedOps) {
      const status = await probe(
        app,
        path,
        method,
        { 'content-type': 'application/json' },
        method === 'post' ? '{}' : undefined,
      );
      expect(status, `${method} ${path} without a session`).toBe(401);
    }
  });

  it('the unauthenticated login surface does NOT 401 (it is hit before a session exists)', async () => {
    const app = fullPortal();
    // GET /api/config + /api/login/start are reachable unauthenticated; POST /api/session is login
    // itself (400 on a bad body, never 401-by-missing-session); DELETE /api/session is logout (204).
    expect(await probe(app, '/api/config', 'get', {})).toBe(200);
    expect(await probe(app, '/api/login/start', 'get', {})).toBe(200);
    expect(await probe(app, '/api/session', 'delete', {})).toBe(204);
    // GET /api/session without a session is the only public-surface 401 (it reports "not signed in").
    expect(await probe(app, '/api/session', 'get', {})).toBe(401);
  });
});
