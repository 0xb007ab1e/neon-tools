import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import type { TenantForge, TenantSummary } from '../../src/app/lib.js';
import type { TenantAuthenticator } from '../../src/ports/tenant-authenticator.js';
import { createPortal } from '../../src/app/portal.js';

const SECRET = 'portal-contract-secret';

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
    .filter((m) => ['get', 'post'].includes(m))
    .map((method) => ({ path, method })),
);

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

describe('Portal OpenAPI contract ↔ sub-app', () => {
  it('documents at least the three live areas + destructive set', () => {
    expect(operations.length).toBeGreaterThanOrEqual(11);
  });

  it.each(operations)('serves $method $path (documented → routed)', async ({ path, method }) => {
    const app = createPortal({
      tf: permissiveTf(),
      authenticator: auth,
      sessionSecret: SECRET,
      enableDestructiveActions: true, // document the full surface, so route the full surface
    });
    const { cookie, csrf } = await loggedIn(app);
    const body: Record<string, unknown> = {
      newPriceUsd: 1,
      setupIntentId: 'si',
      action: 'cancel',
      code: '123456',
      confirm: 'ERASE',
    };
    const res = await app.request(`/api${path.replace('/api', '')}`, {
      method: method.toUpperCase(),
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-tf-csrf': csrf,
        'sec-fetch-site': 'same-origin',
      },
      ...(method === 'post' ? { body: JSON.stringify(body) } : {}),
    });
    // The route exists (not a 404/405 from the router). Behavior is asserted elsewhere.
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(405);
  });

  it('every mutation rejects a missing session (cookie-session auth required)', async () => {
    const app = createPortal({
      tf: permissiveTf(),
      authenticator: auth,
      sessionSecret: SECRET,
      enableDestructiveActions: true,
    });
    for (const { path } of operations.filter((o) => o.method === 'post')) {
      const res = await app.request(`/api${path.replace('/api', '')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(401);
    }
  });
});
