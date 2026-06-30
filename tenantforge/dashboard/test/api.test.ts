import { afterEach, describe, expect, it, vi } from 'vitest';
import * as api from '../src/api';

/**
 * Unit tests for the dashboard API client (dashboard/src/api.ts) — the thin fetch-wrapper layer
 * between the SPA and the control-plane backend. These exercise both the happy path AND the
 * error/negative branches (`if (!res.ok) throw`, 401→null session, 404→null lookups, 403→forbidden)
 * that App.test.tsx's integration flow doesn't reach, so the dashboard logic layer meets the
 * coverage baseline. The client is untrusted; all authorization is enforced server-side — these
 * tests assert error surfacing, not security decisions.
 */

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Stub global fetch to return a fixed response for the single call under test. */
function stubFetch(res: Response): ReturnType<typeof vi.fn> {
  const f = vi.fn(() => Promise.resolve(res));
  vi.stubGlobal('fetch', f);
  return f;
}

afterEach(() => vi.unstubAllGlobals());

describe('dashboard api — session/auth flows', () => {
  it('fetchSession returns the session on 200', async () => {
    stubFetch(json({ id: 'op', role: 'admin' }));
    await expect(api.fetchSession()).resolves.toEqual({ id: 'op', role: 'admin' });
  });

  it('fetchSession returns null on 401 (unauthenticated)', async () => {
    stubFetch(json({}, 401));
    await expect(api.fetchSession()).resolves.toBeNull();
  });

  it('fetchSession throws on a non-401 error status', async () => {
    stubFetch(json({}, 500));
    await expect(api.fetchSession()).rejects.toThrow('Could not check session');
  });

  it('login returns the session on success', async () => {
    stubFetch(json({ id: 'op', role: 'admin' }));
    await expect(api.login('tok')).resolves.toEqual({ id: 'op', role: 'admin' });
  });

  it('login throws "Invalid operator token" on 401', async () => {
    stubFetch(json({}, 401));
    await expect(api.login('bad')).rejects.toThrow('Invalid operator token');
  });

  it('login throws "Login failed" on a non-401 error', async () => {
    stubFetch(json({}, 500));
    await expect(api.login('tok')).rejects.toThrow('Login failed');
  });

  it('logout resolves regardless of response (best-effort DELETE)', async () => {
    const f = stubFetch(new Response(null, { status: 204 }));
    await expect(api.logout()).resolves.toBeUndefined();
    expect(f).toHaveBeenCalledWith(expect.stringContaining('/session'), {
      method: 'DELETE',
      credentials: 'include',
    });
  });
});

describe('dashboard api — null-returning lookups (404)', () => {
  it('fetchEvidenceBundle returns null on 404 (unknown id)', async () => {
    stubFetch(json({}, 404));
    await expect(api.fetchEvidenceBundle('missing')).resolves.toBeNull();
  });

  it('fetchEvidenceBundle returns the bundle on 200', async () => {
    stubFetch(json({ bundle: { scope: 'fleet' }, jws: 'a.b.c' }));
    await expect(api.fetchEvidenceBundle('b1')).resolves.toEqual({
      bundle: { scope: 'fleet' },
      jws: 'a.b.c',
    });
  });

  it('fetchEvidenceBundle throws on a non-404 error', async () => {
    stubFetch(json({}, 500));
    await expect(api.fetchEvidenceBundle('b1')).rejects.toThrow(
      'Could not load the evidence bundle',
    );
  });

  it('fetchEvidencePublicKey returns null on 404 (no signer wired)', async () => {
    stubFetch(json({}, 404));
    await expect(api.fetchEvidencePublicKey()).resolves.toBeNull();
  });

  it('fetchEvidencePublicKey returns the JWK on 200', async () => {
    stubFetch(json({ publicKey: { kty: 'OKP', crv: 'Ed25519', x: 'xx' } }));
    await expect(api.fetchEvidencePublicKey()).resolves.toEqual({
      kty: 'OKP',
      crv: 'Ed25519',
      x: 'xx',
    });
  });

  it('fetchEvidencePublicKey throws on a non-404 error', async () => {
    stubFetch(json({}, 500));
    await expect(api.fetchEvidencePublicKey()).rejects.toThrow(
      'Could not load the evidence public key',
    );
  });
});

describe('dashboard api — runReconcile (mutating)', () => {
  it('returns the result on success', async () => {
    stubFetch(json({ target: '0003', reconciled: ['t1'], partial: [] }));
    await expect(api.runReconcile()).resolves.toEqual({
      target: '0003',
      reconciled: ['t1'],
      partial: [],
    });
  });

  it('throws "Not permitted" on 403', async () => {
    stubFetch(json({}, 403));
    await expect(api.runReconcile()).rejects.toThrow('Not permitted');
  });

  it('throws "Reconcile failed" on a non-403 error', async () => {
    stubFetch(json({}, 500));
    await expect(api.runReconcile()).rejects.toThrow('Reconcile failed');
  });
});

/**
 * Every remaining read fetcher follows the same shape: GET, unwrap a known key (or the body), and
 * `throw new Error(<message>)` on `!res.ok`. Table-drive the happy + error branch for each so the
 * uncovered error-throw branches are all exercised. `body` is the success payload; `expected` is
 * what the wrapper unwraps to.
 */
const readers: {
  name: string;
  call: () => Promise<unknown>;
  body: unknown;
  expected: unknown;
  errorMessage: string;
}[] = [
  {
    name: 'fetchCompliance',
    call: () => api.fetchCompliance(),
    body: { report: { generatedAt: 'x' }, digest: 'd' },
    expected: { report: { generatedAt: 'x' }, digest: 'd' },
    errorMessage: 'Could not load the compliance report',
  },
  {
    name: 'fetchEvidenceBundles',
    call: () => api.fetchEvidenceBundles(),
    body: { manifests: [{ bundleId: 'b1' }] },
    expected: [{ bundleId: 'b1' }],
    errorMessage: 'Could not load evidence bundles',
  },
  {
    name: 'fetchOperatorDigest',
    call: () => api.fetchOperatorDigest(),
    body: { severity: 'ok', totalIssues: 0 },
    expected: { severity: 'ok', totalIssues: 0 },
    errorMessage: 'Could not load the operator digest',
  },
  {
    name: 'fetchWebhookSubscriptions',
    call: () => api.fetchWebhookSubscriptions(),
    body: { subscriptions: [{ id: 's1' }] },
    expected: [{ id: 's1' }],
    errorMessage: 'Could not load webhook subscriptions',
  },
  {
    name: 'fetchDrift',
    call: () => api.fetchDrift(),
    body: { latest: '0003' },
    expected: { latest: '0003' },
    errorMessage: 'Could not load fleet drift',
  },
  {
    name: 'fetchCost',
    call: () => api.fetchCost(),
    body: { generatedAt: 'x', rows: [] },
    expected: { generatedAt: 'x', rows: [] },
    errorMessage: 'Could not load the cost report',
  },
  {
    name: 'fetchCostAnomalies',
    call: () => api.fetchCostAnomalies(),
    body: { anomalies: [{ kind: 'unprofitable' }] },
    expected: [{ kind: 'unprofitable' }],
    errorMessage: 'Could not load cost anomalies',
  },
  {
    name: 'fetchInvoices',
    call: () => api.fetchInvoices(),
    body: { generatedAt: 'x', invoices: [] },
    expected: { generatedAt: 'x', invoices: [] },
    errorMessage: 'Could not load invoices',
  },
  {
    name: 'fetchReconcilePlan',
    call: () => api.fetchReconcilePlan(),
    body: { target: '0003', perTenant: [] },
    expected: { target: '0003', perTenant: [] },
    errorMessage: 'Could not load the reconcile plan',
  },
  {
    name: 'fetchReconcileHistory',
    call: () => api.fetchReconcileHistory(),
    body: { history: [{ at: 'x' }] },
    expected: [{ at: 'x' }],
    errorMessage: 'Could not load reconcile history',
  },
  {
    name: 'fetchReconcileCapabilities',
    call: () => api.fetchReconcileCapabilities(),
    body: { executable: true, mayExecute: false },
    expected: { executable: true, mayExecute: false },
    errorMessage: 'Could not load reconcile capabilities',
  },
  {
    name: 'fetchCharges',
    call: () => api.fetchCharges(),
    body: { charges: [{ at: 'x' }] },
    expected: [{ at: 'x' }],
    errorMessage: 'Could not load charges',
  },
  {
    name: 'fetchPaymentEvents',
    call: () => api.fetchPaymentEvents(),
    body: { events: [{ at: 'x' }] },
    expected: [{ at: 'x' }],
    errorMessage: 'Could not load payment events',
  },
  {
    name: 'fetchDunning',
    call: () => api.fetchDunning(),
    body: { events: [{ at: 'x' }] },
    expected: [{ at: 'x' }],
    errorMessage: 'Could not load dunning history',
  },
  {
    name: 'fetchBillingRuns',
    call: () => api.fetchBillingRuns(),
    body: { runs: [{ at: 'x' }] },
    expected: [{ at: 'x' }],
    errorMessage: 'Could not load billing runs',
  },
  {
    name: 'fetchRefunds',
    call: () => api.fetchRefunds(),
    body: { refunds: [{ at: 'x' }] },
    expected: [{ at: 'x' }],
    errorMessage: 'Could not load refunds',
  },
  {
    name: 'fetchNotifications',
    call: () => api.fetchNotifications(),
    body: { notifications: [{ at: 'x' }] },
    expected: [{ at: 'x' }],
    errorMessage: 'Could not load notifications',
  },
  {
    name: 'fetchPlanChanges',
    call: () => api.fetchPlanChanges(),
    body: { planChanges: [{ at: 'x' }] },
    expected: [{ at: 'x' }],
    errorMessage: 'Could not load plan changes',
  },
  {
    name: 'fetchRetention',
    call: () => api.fetchRetention(),
    body: { generatedAt: 'x', tenants: [] },
    expected: { generatedAt: 'x', tenants: [] },
    errorMessage: 'Could not load the retention report',
  },
  {
    name: 'fetchExports',
    call: () => api.fetchExports(),
    body: { exports: [{ at: 'x' }] },
    expected: [{ at: 'x' }],
    errorMessage: 'Could not load data exports',
  },
  {
    name: 'fetchCreditGrants',
    call: () => api.fetchCreditGrants(),
    body: { creditGrants: [{ at: 'x' }] },
    expected: [{ at: 'x' }],
    errorMessage: 'Could not load credit grants',
  },
  {
    name: 'fetchUsageAlerts',
    call: () => api.fetchUsageAlerts(),
    body: { usageAlerts: [{ at: 'x' }] },
    expected: [{ at: 'x' }],
    errorMessage: 'Could not load usage alerts',
  },
  {
    name: 'fetchPlans',
    call: () => api.fetchPlans(),
    body: { plans: [{ id: 'p1' }] },
    expected: [{ id: 'p1' }],
    errorMessage: 'Could not load plans',
  },
  {
    name: 'fetchSignupTokens',
    call: () => api.fetchSignupTokens(),
    body: { signupTokens: [{ slug: 's' }] },
    expected: [{ slug: 's' }],
    errorMessage: 'Could not load signup tokens',
  },
  {
    name: 'fetchInvoicesSent',
    call: () => api.fetchInvoicesSent(),
    body: { invoicesSent: [{ at: 'x' }] },
    expected: [{ at: 'x' }],
    errorMessage: 'Could not load invoice deliveries',
  },
  {
    name: 'fetchAudit',
    call: () => api.fetchAudit(),
    body: { events: [{ at: 'x' }] },
    expected: [{ at: 'x' }],
    errorMessage: 'Could not load audit trail',
  },
  {
    name: 'fetchAuditAnomalies',
    call: () => api.fetchAuditAnomalies(),
    body: { anomalies: [{ kind: 'error-spike' }] },
    expected: [{ kind: 'error-spike' }],
    errorMessage: 'Could not load audit anomalies',
  },
];

describe('dashboard api — read fetchers (happy + error branch)', () => {
  for (const r of readers) {
    it(`${r.name} unwraps the payload on 200`, async () => {
      stubFetch(json(r.body));
      await expect(r.call()).resolves.toEqual(r.expected);
    });
    it(`${r.name} throws "${r.errorMessage}" on a non-2xx response`, async () => {
      stubFetch(json({}, 500));
      await expect(r.call()).rejects.toThrow(r.errorMessage);
    });
  }
});
