import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPortal } from '../../src/app/portal.js';
import type { TenantForge, TenantSummary } from '../../src/app/lib.js';
import type { TenantAuthenticator } from '../../src/ports/tenant-authenticator.js';

const SECRET = 'portal-session-secret';

/**
 * A configurable fake {@link TenantForge} that records the tenant id each self-serve method was
 * called with — so the abuse tests can assert a mutation only ever touched the *session* tenant.
 */
interface FakeState {
  /** The last tenant id each method was invoked with (proves self-scoping). */
  calls: Record<string, string | undefined>;
  /** Tenants the fake knows about (anything else → "not found"). */
  tenants: Set<string>;
  /** Stripe-side customer ref per tenant (undefined ⇒ no billing customer → F5 fail-closed). */
  customerRef: Record<string, string | undefined>;
  /** SetupIntent customer refs, to simulate the F5 mismatch check. */
  intentCustomer: Record<string, string>;
  /** Whether a presented step-up code verifies (per action). */
  stepUpOk: boolean;
  /** Pending erasure per tenant. */
  pending: Record<string, { requestedAt: string; executeAt: string; status: string } | null>;
}

const newState = (): FakeState => ({
  calls: {},
  tenants: new Set(['t-a', 't-b']),
  customerRef: { 't-a': 'cus_a', 't-b': 'cus_b' },
  intentCustomer: { si_a: 'cus_a', si_other: 'cus_other' },
  stepUpOk: true,
  pending: {},
});

const fakeTf = (s: FakeState): TenantForge =>
  ({
    tenantSummary: (id: string): Promise<TenantSummary | null> =>
      Promise.resolve(
        s.tenants.has(id)
          ? {
              id,
              slug: id === 't-a' ? 'acme' : 'beta',
              region: 'aws-us-east-1',
              status: 'active',
              createdAt: '2026-01-01T00:00:00.000Z',
              planPriceUsd: 9,
            }
          : null,
      ),
    tenantCharges: () => Promise.resolve([]),
    tenantRefunds: () => Promise.resolve([]),
    tenantNotifications: () => Promise.resolve([]),
    usage: (id: string) =>
      Promise.resolve({
        tenantId: id,
        neonProjectId: 'proj',
        period: { from: 'x', to: 'y' },
        consumption: {
          computeTimeSeconds: 0,
          activeTimeSeconds: 0,
          writtenDataBytes: 0,
          syntheticStorageBytes: 0,
        },
      }),
    listPlans: () => [{ id: 'pro', priceUsd: 29 }],
    previewPlanChange: (id: string, newPriceUsd: number) => {
      s.calls['previewPlanChange'] = id;
      return Promise.resolve({
        tenantId: id,
        oldPriceUsd: 9,
        newPriceUsd,
        period: { from: 'a', to: 'b' },
        proratedDeltaMinor: 100,
      });
    },
    changePlan: (id: string, newPriceUsd: number) => {
      s.calls['changePlan'] = id;
      return Promise.resolve({
        tenantId: id,
        oldPriceUsd: 9,
        newPriceUsd,
        period: { from: 'a', to: 'b' },
        proratedDeltaMinor: 100,
        settlement: 'charged' as const,
        settlementId: `set_${Math.random().toString(36).slice(2)}`,
      });
    },
    tenantPaymentSetup: (id: string) => {
      s.calls['tenantPaymentSetup'] = id;
      if (s.customerRef[id] === undefined) {
        return Promise.reject(
          new Error('no billing customer on file; cannot add a payment method'),
        );
      }
      return Promise.resolve({ clientSecret: 'cs_x', setupIntentId: 'si_x' });
    },
    confirmTenantPaymentMethod: (id: string, setupIntentId: string) => {
      s.calls['confirmTenantPaymentMethod'] = id;
      const want = s.customerRef[id];
      if (want === undefined) return Promise.reject(new Error('no billing customer on file'));
      const got = s.intentCustomer[setupIntentId];
      if (got === undefined) return Promise.reject(new Error('payment method not confirmed'));
      if (got !== want) return Promise.reject(new Error('payment/customer mismatch'));
      return Promise.resolve({ tenantId: id, hasDefault: true as const, setupIntentId });
    },
    tenantInvoices: (id: string) => {
      s.calls['tenantInvoices'] = id;
      return Promise.resolve([
        {
          tenantId: id,
          periodStart: '2026-06-01',
          periodEnd: '2026-06-24',
          currency: 'usd',
          generatedAt: '2026-06-24',
          lineItems: [],
          totalUsd: 9,
        },
      ]);
    },
    creditBalance: (id: string) => {
      s.calls['creditBalance'] = id;
      return Promise.resolve(500);
    },
    requestTenantStepUp: (id: string) => {
      s.calls['requestTenantStepUp'] = id;
      return Promise.resolve();
    },
    verifyTenantStepUp: (id: string) => {
      s.calls['verifyTenantStepUp'] = id;
      return Promise.resolve(s.stepUpOk);
    },
    cancelTenant: (id: string) => {
      s.calls['cancelTenant'] = id;
      return Promise.resolve({
        tenantId: id,
        status: 'offboarding',
        reversibleUntil: '2026-07-24T00:00:00.000Z',
      });
    },
    exportTenantData: (id: string) => {
      s.calls['exportTenantData'] = id;
      return Promise.resolve({ location: 'archive://x', bytes: 10 });
    },
    requestTenantErasure: (id: string) => {
      s.calls['requestTenantErasure'] = id;
      s.pending[id] = {
        requestedAt: '2026-06-24T00:00:00.000Z',
        executeAt: '2026-06-26T00:00:00.000Z',
        status: 'pending',
      };
      return Promise.resolve({
        tenantId: id,
        requestedAt: '2026-06-24T00:00:00.000Z',
        executeAt: '2026-06-26T00:00:00.000Z',
        status: 'pending' as const,
      });
    },
    cancelTenantErasure: (id: string) => {
      s.calls['cancelTenantErasure'] = id;
      const had = s.pending[id] != null;
      s.pending[id] = null;
      return Promise.resolve(had);
    },
    pendingErasure: (id: string) => Promise.resolve(s.pending[id] ?? null),
  }) as unknown as TenantForge;

const auth: TenantAuthenticator = {
  authenticate: (token: string) =>
    Promise.resolve(
      token === 'tok-a' ? { tenantId: 't-a' } : token === 'tok-b' ? { tenantId: 't-b' } : null,
    ),
};

/** A fixed clock so the session `exp` (now + 1h ttl) — and thus the session-bound CSRF token — is deterministic. */
const NOW = 1_700_000_000_000;
const TTL_MS = 60 * 60 * 1000; // portal default
const SESSION_EXP = NOW + TTL_MS;

const portal = (
  s: FakeState,
  opts: { destructive?: boolean } = {},
): ReturnType<typeof createPortal> =>
  createPortal({
    tf: fakeTf(s),
    authenticator: auth,
    sessionSecret: SECRET,
    enableDestructiveActions: opts.destructive ?? false,
    now: () => NOW,
  });

async function login(app: ReturnType<typeof createPortal>, token: string): Promise<string> {
  const res = await app.request('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
  });
  return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
}

/**
 * Compute the session-bound CSRF token a logged-in client reads from `/api/csrf`:
 * `tenantId.HMAC(csrf:{tenantId}:{exp})`. With the fixed clock the `exp` is deterministic.
 */
function csrfFor(tenantId: string, exp: number = SESSION_EXP): string {
  const sig = createHmac('sha256', SECRET).update(`csrf:${tenantId}:${exp}`).digest('base64url');
  return `${tenantId}.${sig}`;
}

/** Headers for a same-origin mutation with a valid CSRF token. */
const mutHeaders = (cookie: string, tenantId: string): Record<string, string> => ({
  cookie,
  'content-type': 'application/json',
  'x-tf-csrf': csrfFor(tenantId),
  'sec-fetch-site': 'same-origin',
});

describe('portal self-serve — reads', () => {
  it('GET /api/plan returns current + available; GET /api/credit-balance + /api/invoices scoped', async () => {
    const s = newState();
    const app = portal(s);
    const cookie = await login(app, 'tok-a');
    const plan = await app.request('/api/plan', { headers: { cookie } });
    expect(plan.status).toBe(200);
    expect((await plan.json()) as Record<string, unknown>).toMatchObject({
      current: 9,
      available: [{ id: 'pro', priceUsd: 29 }],
    });
    const bal = await app.request('/api/credit-balance', { headers: { cookie } });
    expect((await bal.json()) as Record<string, unknown>).toMatchObject({ balanceMinor: 500 });
    expect(s.calls['creditBalance']).toBe('t-a');
    const inv = await app.request('/api/invoices', { headers: { cookie } });
    expect(((await inv.json()) as { invoices: unknown[] }).invoices).toHaveLength(1);
    expect(s.calls['tenantInvoices']).toBe('t-a');
  });

  it('issues a signed per-session CSRF token via GET /api/csrf', async () => {
    const s = newState();
    const app = portal(s);
    const cookie = await login(app, 'tok-a');
    const res = await app.request('/api/csrf', { headers: { cookie } });
    expect(((await res.json()) as { csrfToken: string }).csrfToken).toBe(csrfFor('t-a'));
  });
});

describe('portal self-serve — plan change', () => {
  it('previews + changes the plan with a valid CSRF token, scoped to the session tenant', async () => {
    const s = newState();
    const app = portal(s);
    const cookie = await login(app, 'tok-a');
    const prev = await app.request('/api/plan/preview', {
      method: 'POST',
      headers: mutHeaders(cookie, 't-a'),
      body: JSON.stringify({ newPriceUsd: 29 }),
    });
    expect(prev.status).toBe(200);
    expect(s.calls['previewPlanChange']).toBe('t-a');
    const chg = await app.request('/api/plan/change', {
      method: 'POST',
      headers: mutHeaders(cookie, 't-a'),
      body: JSON.stringify({ newPriceUsd: 29 }),
    });
    expect(chg.status).toBe(200);
    expect(s.calls['changePlan']).toBe('t-a');
  });

  it('rejects a mutation with NO CSRF token (403)', async () => {
    const s = newState();
    const app = portal(s);
    const cookie = await login(app, 'tok-a');
    const res = await app.request('/api/plan/change', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ newPriceUsd: 29 }),
    });
    expect(res.status).toBe(403);
    expect(s.calls['changePlan']).toBeUndefined(); // never reached the facade
  });

  it('rejects a mutation with another tenant’s CSRF token (signed-token is tenant-bound)', async () => {
    const s = newState();
    const app = portal(s);
    const cookie = await login(app, 'tok-a');
    const res = await app.request('/api/plan/change', {
      method: 'POST',
      headers: { ...mutHeaders(cookie, 't-b') }, // token for t-b, session is t-a
      body: JSON.stringify({ newPriceUsd: 29 }),
    });
    expect(res.status).toBe(403);
    expect(s.calls['changePlan']).toBeUndefined();
  });

  it('rejects a cross-site mutation via Sec-Fetch-Site (403)', async () => {
    const s = newState();
    const app = portal(s);
    const cookie = await login(app, 'tok-a');
    const res = await app.request('/api/plan/change', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-tf-csrf': csrfFor('t-a'),
        'sec-fetch-site': 'cross-site',
      },
      body: JSON.stringify({ newPriceUsd: 29 }),
    });
    expect(res.status).toBe(403);
    expect(s.calls['changePlan']).toBeUndefined();
  });

  it('rejects a CSRF token minted for a DIFFERENT (old/expired) session (L1 — session-bound)', async () => {
    const s = newState();
    const app = portal(s);
    const cookie = await login(app, 'tok-a');
    // A token bound to a prior session's expiry (e.g. before logout/re-login) must NOT verify against
    // the live session — so a leaked token dies with its session rather than being forever valid.
    const staleToken = csrfFor('t-a', SESSION_EXP - 1);
    const res = await app.request('/api/plan/change', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-tf-csrf': staleToken,
        'sec-fetch-site': 'same-origin',
      },
      body: JSON.stringify({ newPriceUsd: 29 }),
    });
    expect(res.status).toBe(403);
    expect(s.calls['changePlan']).toBeUndefined();
  });

  it('the /api/csrf token verifies against the live session (round-trip)', async () => {
    const s = newState();
    const app = portal(s);
    const cookie = await login(app, 'tok-a');
    const token = (
      (await (await app.request('/api/csrf', { headers: { cookie } })).json()) as {
        csrfToken: string;
      }
    ).csrfToken;
    expect(token).toBe(csrfFor('t-a')); // bound to the live session's exp
    const res = await app.request('/api/plan/change', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-tf-csrf': token,
        'sec-fetch-site': 'same-origin',
      },
      body: JSON.stringify({ newPriceUsd: 29 }),
    });
    expect(res.status).toBe(200);
  });

  it('an idempotency replay applies the change exactly once', async () => {
    const s = newState();
    const app = portal(s);
    const cookie = await login(app, 'tok-a');
    const headers = { ...mutHeaders(cookie, 't-a'), 'idempotency-key': 'k-1' };
    const body = JSON.stringify({ newPriceUsd: 29 });
    const first = await app.request('/api/plan/change', { method: 'POST', headers, body });
    const second = await app.request('/api/plan/change', { method: 'POST', headers, body });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // Same settlementId replayed verbatim → the facade ran exactly once.
    const a = (await first.json()) as { settlementId: string };
    const b = (await second.json()) as { settlementId: string };
    expect(b.settlementId).toBe(a.settlementId);
  });
});

describe('portal self-serve — payment method (F5)', () => {
  it('opens a setup-intent for the session tenant', async () => {
    const s = newState();
    const app = portal(s);
    const cookie = await login(app, 'tok-a');
    const res = await app.request('/api/payment-method/setup-intent', {
      method: 'POST',
      headers: mutHeaders(cookie, 't-a'),
    });
    expect(res.status).toBe(200);
    expect(s.calls['tenantPaymentSetup']).toBe('t-a');
  });

  it('fails closed when the tenant has no billing customer (F5)', async () => {
    const s = newState();
    s.customerRef['t-a'] = undefined;
    const app = portal(s);
    const cookie = await login(app, 'tok-a');
    const res = await app.request('/api/payment-method/setup-intent', {
      method: 'POST',
      headers: mutHeaders(cookie, 't-a'),
    });
    expect(res.status).toBe(409);
  });

  it('rejects a SetupIntent whose customerRef ≠ the tenant’s (PSP-side BOLA — F5)', async () => {
    const s = newState();
    const app = portal(s);
    const cookie = await login(app, 'tok-a');
    const res = await app.request('/api/payment-method/set-default', {
      method: 'POST',
      headers: mutHeaders(cookie, 't-a'),
      body: JSON.stringify({ setupIntentId: 'si_other' }), // customer cus_other ≠ cus_a
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: 'payment/customer mismatch',
    });
  });

  it('sets the default when the SetupIntent matches the tenant’s customer', async () => {
    const s = newState();
    const app = portal(s);
    const cookie = await login(app, 'tok-a');
    const res = await app.request('/api/payment-method/set-default', {
      method: 'POST',
      headers: mutHeaders(cookie, 't-a'),
      body: JSON.stringify({ setupIntentId: 'si_a' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ hasDefault: true });
  });
});

describe('portal self-serve — destructive actions feature flag (F6)', () => {
  it('cancel/erasure/export are 404 when the flag is OFF (default)', async () => {
    const s = newState();
    const app = portal(s, { destructive: false });
    const cookie = await login(app, 'tok-a');
    for (const path of ['/api/cancel', '/api/erasure', '/api/data-export', '/api/erasure/cancel']) {
      const res = await app.request(path, { method: 'POST', headers: mutHeaders(cookie, 't-a') });
      expect(res.status).toBe(404);
    }
    expect(s.calls['cancelTenant']).toBeUndefined();
  });
});

describe('portal self-serve — destructive actions (flag ON, step-up gated)', () => {
  it('cancel requires a valid step-up code, then offboards + surfaces reversibleUntil', async () => {
    const s = newState();
    const app = portal(s, { destructive: true });
    const cookie = await login(app, 'tok-a');
    const res = await app.request('/api/cancel', {
      method: 'POST',
      headers: mutHeaders(cookie, 't-a'),
      body: JSON.stringify({ code: '123456' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      status: 'offboarding',
      reversibleUntil: '2026-07-24T00:00:00.000Z',
    });
    expect(s.calls['cancelTenant']).toBe('t-a');
  });

  it('cancel WITHOUT a valid step-up factor is rejected (403) — F1 bypass blocked', async () => {
    const s = newState();
    s.stepUpOk = false; // the second factor does not verify
    const app = portal(s, { destructive: true });
    const cookie = await login(app, 'tok-a');
    const res = await app.request('/api/cancel', {
      method: 'POST',
      headers: mutHeaders(cookie, 't-a'),
      body: JSON.stringify({ code: '000000' }),
    });
    expect(res.status).toBe(403);
    expect(s.calls['cancelTenant']).toBeUndefined(); // never offboarded
  });

  it('erasure requires the typed confirm + step-up; schedules (does not delete synchronously)', async () => {
    const s = newState();
    const app = portal(s, { destructive: true });
    const cookie = await login(app, 'tok-a');
    // Missing the typed confirm → 400 (schema).
    const bad = await app.request('/api/erasure', {
      method: 'POST',
      headers: mutHeaders(cookie, 't-a'),
      body: JSON.stringify({ code: '123456' }),
    });
    expect(bad.status).toBe(400);
    // With confirm + a verifying code → schedules a pending erasure.
    const ok = await app.request('/api/erasure', {
      method: 'POST',
      headers: mutHeaders(cookie, 't-a'),
      body: JSON.stringify({ code: '123456', confirm: 'ERASE' }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()) as Record<string, unknown>).toMatchObject({ status: 'pending' });
    expect(s.calls['requestTenantErasure']).toBe('t-a');
    // The tenant keeps serving — a read still works (no suspend during the window).
    expect((await app.request('/api/plan', { headers: { cookie } })).status).toBe(200);
  });

  it('erasure step-up bypass is rejected (403)', async () => {
    const s = newState();
    s.stepUpOk = false;
    const app = portal(s, { destructive: true });
    const cookie = await login(app, 'tok-a');
    const res = await app.request('/api/erasure', {
      method: 'POST',
      headers: mutHeaders(cookie, 't-a'),
      body: JSON.stringify({ code: '000000', confirm: 'ERASE' }),
    });
    expect(res.status).toBe(403);
    expect(s.calls['requestTenantErasure']).toBeUndefined();
  });

  it('cancelling a pending erasure before the window leaves it cancellable (undo)', async () => {
    const s = newState();
    const app = portal(s, { destructive: true });
    const cookie = await login(app, 'tok-a');
    await app.request('/api/erasure', {
      method: 'POST',
      headers: mutHeaders(cookie, 't-a'),
      body: JSON.stringify({ code: '123456', confirm: 'ERASE' }),
    });
    const cancel = await app.request('/api/erasure/cancel', {
      method: 'POST',
      headers: mutHeaders(cookie, 't-a'),
    });
    expect(cancel.status).toBe(200);
    expect((await cancel.json()) as Record<string, unknown>).toMatchObject({ cancelled: true });
    // No pending erasure remains.
    const status = await app.request('/api/erasure', { headers: { cookie } });
    expect((await status.json()) as { pending: unknown }).toMatchObject({ pending: null });
  });
});

describe('portal self-serve — cross-tenant mutation (B8w)', () => {
  it('a session for A can never name or affect B; no route accepts a tenantId', async () => {
    const s = newState();
    const app = portal(s, { destructive: true });
    const cookie = await login(app, 'tok-a');
    // Query/body attempts to name another tenant are ignored — the session tenant is always used.
    await app.request('/api/plan/change?tenantId=t-b', {
      method: 'POST',
      headers: mutHeaders(cookie, 't-a'),
      body: JSON.stringify({ newPriceUsd: 29, tenantId: 't-b' }),
    });
    expect(s.calls['changePlan']).toBe('t-a'); // NOT t-b
    await app.request('/api/cancel', {
      method: 'POST',
      headers: mutHeaders(cookie, 't-a'),
      body: JSON.stringify({ code: '123456', tenantId: 't-b' }),
    });
    expect(s.calls['cancelTenant']).toBe('t-a'); // NOT t-b
  });

  it('every mutation requires a session (401 unauthenticated)', async () => {
    const s = newState();
    const app = portal(s, { destructive: true });
    for (const path of [
      '/api/plan/change',
      '/api/payment-method/setup-intent',
      '/api/cancel',
      '/api/erasure',
    ]) {
      const res = await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(401);
    }
  });
});
