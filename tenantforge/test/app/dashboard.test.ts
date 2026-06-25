import { describe, expect, it } from 'vitest';
import { createHttpServer } from '../../src/app/http-server.js';
import type { TenantForge } from '../../src/app/lib.js';

const TOKEN = 'op-token';
const fakeTf = (o: Partial<TenantForge>): TenantForge => o as unknown as TenantForge;
const report = { report: { inventory: { total: 3 } }, digest: 'd1' };
const drift = {
  latest: '0003',
  totalVersions: 3,
  tenants: [],
  summary: { total: 0, atLatest: 0, drifted: 0, withFailures: 0 },
};
const cost = {
  generatedAt: 'x',
  rows: [],
  unmetered: [],
  totals: { tenants: 0, costUsd: 0, priceUsd: 0, marginUsd: 0, unprofitable: 0, unpriced: 0 },
};
const reconcile = {
  target: '0003',
  perTenant: [],
  pendingTenants: [],
  upToDate: [],
  totalMissing: 0,
  batches: [],
};
const invoices = { generatedAt: 'x', invoices: [], unmetered: [] };
const app = () =>
  createHttpServer(
    fakeTf({
      complianceReport: async () => report as never,
      evidenceList: async () =>
        [
          {
            bundleId: 'evb-1',
            scope: 'fleet',
            generatedAt: 'x',
            storedAt: 'y',
            signerKid: 'kid-1',
            contentHashes: {
              inventory: 'h1',
              isolation: 'h2',
              residency: 'h3',
              auditExcerpt: 'h4',
              erasureCertificates: 'h5',
            },
          },
        ] as never,
      evidenceGet: async (bundleId: string, tenantScope: string | null) => {
        // BOLA: the operator dashboard surface must always fetch at FLEET scope (`null`) — never a
        // client-supplied tenant id. Lock that boundary at the dashboard layer (throws → 500 → fails).
        expect(tenantScope).toBeNull();
        return bundleId === 'evb-1'
          ? ({ bundle: { scope: 'fleet', generatedAt: 'x' }, jws: 'a.b.c' } as never)
          : null;
      },
      evidenceBundlePublicKey: async () => ({ kty: 'OKP', crv: 'Ed25519', x: 'pub', kid: 'kid-1' }),
      operatorDigest: async () =>
        ({ severity: 'ok', headline: 'ok: all clear', categories: [] }) as never,
      listWebhookSubscriptions: async () =>
        [
          { id: 's1', url: 'https://hook.test/x', eventTypes: [], active: true, createdAt: 'x' },
        ] as never,
      fleetStatus: async () => drift,
      costReport: async () => cost,
      reconcilePlan: async () => reconcile,
      reconcileHistory: async () => [{ event: 'fleet.reconcile', at: 'x', outcome: 'ok' }] as never,
      invoiceFleet: async () => invoices,
      chargeHistory: async () => [{ event: 'tenant.charged', at: 'x', outcome: 'ok' }] as never,
      paymentWebhookHistory: async () =>
        [{ event: 'payment.webhook', at: 'x', outcome: 'ok' }] as never,
      dunningHistory: async () => [{ event: 'tenant.dunning', at: 'x', outcome: 'ok' }] as never,
      billingRunHistory: async () => [{ event: 'billing.run', at: 'x', outcome: 'ok' }] as never,
      refundHistory: async () => [{ event: 'tenant.refunded', at: 'x', outcome: 'ok' }] as never,
      notificationHistory: async () =>
        [{ event: 'tenant.notified', at: 'x', outcome: 'ok' }] as never,
      planChangeHistory: async () =>
        [{ event: 'tenant.plan_changed', at: 'x', outcome: 'ok' }] as never,
      creditGrantHistory: async () =>
        [{ event: 'tenant.credit_granted', at: 'x', outcome: 'ok' }] as never,
      usageAlertHistory: async () =>
        [{ event: 'tenant.usage_alert', at: 'x', outcome: 'ok' }] as never,
      listPlans: () => [{ id: 'pro', name: 'Pro', priceUsd: 49 }] as never,
      listSignupTokens: async () =>
        [{ slug: 'acme', status: 'pending', expiresAt: 'x', createdAt: 'y' }] as never,
      invoiceDeliveryHistory: async () =>
        [{ event: 'tenant.invoiced', at: 'x', outcome: 'ok' }] as never,
      exportHistory: async () => [{ event: 'tenant.exported', at: 'x', outcome: 'ok' }] as never,
      retentionReport: async () => ({
        generatedAt: 'x',
        retentionDays: 30,
        eligible: 0,
        pending: 0,
        tenants: [],
      }),
      queryAudit: async () => [{ event: 'tenant.transition', at: 'x', outcome: 'ok' }] as never,
      scanAuditAnomalies: async () =>
        [{ kind: 'error-spike', count: 12, events: ['tenant.charged'] }] as never,
      scanCostAnomalies: async () =>
        [
          { kind: 'unprofitable', tenantId: 't1', costUsd: 30, priceUsd: 20, marginUsd: -10 },
        ] as never,
    }),
    { token: TOKEN, dashboardSecret: 'session-secret' },
  );

/** Extract the `tf_dash=…` cookie pair from a Set-Cookie response. */
const cookieOf = (res: Response): string => (res.headers.get('set-cookie') ?? '').split(';')[0]!;

const login = (server: ReturnType<typeof app>, token: string) =>
  server.request('/dashboard/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });

describe('dashboard backend', () => {
  it('exchanges a valid operator token for a session cookie, then serves the compliance panel', async () => {
    const server = app();
    const res = await login(server, TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'default', role: 'admin' });
    const cookie = cookieOf(res);
    expect(cookie).toMatch(/^tf_dash=/);

    const data = await server.request('/dashboard/api/compliance', { headers: { cookie } });
    expect(data.status).toBe(200);
    expect(await data.json()).toEqual(report);
  });

  it('serves the evidence-bundle manifests, a single signed bundle, and the public key to a session', async () => {
    const server = app();
    const cookie = cookieOf(await login(server, TOKEN));

    const list = await server.request('/dashboard/api/evidence/bundles', { headers: { cookie } });
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expect(listBody).toMatchObject({ manifests: [{ bundleId: 'evb-1', scope: 'fleet' }] });
    // Facts only — never the JWS body in the list.
    expect(JSON.stringify(listBody)).not.toContain('a.b.c');

    const one = await server.request('/dashboard/api/evidence/bundles/evb-1', {
      headers: { cookie },
    });
    expect(one.status).toBe(200);
    expect(await one.json()).toEqual({
      bundle: { scope: 'fleet', generatedAt: 'x' },
      jws: 'a.b.c',
    });

    // An unknown id is a uniform 404 (reveals nothing).
    const missing = await server.request('/dashboard/api/evidence/bundles/nope', {
      headers: { cookie },
    });
    expect(missing.status).toBe(404);

    const key = await server.request('/dashboard/api/evidence/public-key', { headers: { cookie } });
    expect(key.status).toBe(200);
    const keyBody = (await key.json()) as { publicKey: Record<string, unknown> };
    expect(keyBody.publicKey).toMatchObject({ kty: 'OKP', crv: 'Ed25519' });
    // The public key carries no private material (`d`).
    expect(keyBody.publicKey.d).toBeUndefined();
  });

  it('rejects unauthenticated evidence panel data (401)', async () => {
    const server = app();
    expect((await server.request('/dashboard/api/evidence/bundles')).status).toBe(401);
    expect((await server.request('/dashboard/api/evidence/bundles/evb-1')).status).toBe(401);
    expect((await server.request('/dashboard/api/evidence/public-key')).status).toBe(401);
  });

  it('forbids evidence reads for a readonly session (403 — requires evidence:read)', async () => {
    const server = createHttpServer(
      fakeTf({
        evidenceList: async () => [] as never,
        evidenceGet: async () => null,
        evidenceBundlePublicKey: async () => null,
      }),
      { credentials: [{ id: 'ro', role: 'readonly', token: 'ro-token' }], dashboardSecret: 's' },
    );
    const cookie = cookieOf(await login(server, 'ro-token'));
    expect(
      (await server.request('/dashboard/api/evidence/bundles', { headers: { cookie } })).status,
    ).toBe(403);
    expect(
      (await server.request('/dashboard/api/evidence/bundles/evb-1', { headers: { cookie } }))
        .status,
    ).toBe(403);
    // The public key is public — a session suffices (no evidence:read needed); 404 when unsigned.
    expect(
      (await server.request('/dashboard/api/evidence/public-key', { headers: { cookie } })).status,
    ).toBe(404);
  });

  it('serves the operator-digest panel data to an authenticated session', async () => {
    const server = app();
    const cookie = cookieOf(await login(server, TOKEN));
    const res = await server.request('/dashboard/api/operator-digest', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ severity: 'ok' });
  });

  it('rejects unauthenticated operator-digest panel data (401)', async () => {
    const res = await app().request('/dashboard/api/operator-digest');
    expect(res.status).toBe(401);
  });

  it('serves the webhook-subscriptions panel data (never the secret) to a session', async () => {
    const server = app();
    const cookie = cookieOf(await login(server, TOKEN));
    const res = await server.request('/dashboard/api/webhook-subscriptions', {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('https://hook.test/x');
    expect(body).not.toContain('secret');
  });

  it('rejects unauthenticated webhook-subscriptions panel data (401)', async () => {
    const res = await app().request('/dashboard/api/webhook-subscriptions');
    expect(res.status).toBe(401);
  });

  it('serves the drift and cost panels for a valid session', async () => {
    const server = app();
    const cookie = cookieOf(await login(server, TOKEN));
    expect((await server.request('/dashboard/api/drift', { headers: { cookie } })).status).toBe(
      200,
    );
    const c = await server.request('/dashboard/api/cost', { headers: { cookie } });
    expect(c.status).toBe(200);
    expect(await c.json()).toEqual(cost);
    const r = await server.request('/dashboard/api/reconcile', { headers: { cookie } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(reconcile);
    const h = await server.request('/dashboard/api/reconcile-history', { headers: { cookie } });
    expect(h.status).toBe(200);
    expect(await h.json()).toEqual({
      history: [{ event: 'fleet.reconcile', at: 'x', outcome: 'ok' }],
    });
    const inv = await server.request('/dashboard/api/invoices', { headers: { cookie } });
    expect(inv.status).toBe(200);
    expect(await inv.json()).toEqual(invoices);
    const ch = await server.request('/dashboard/api/charges', { headers: { cookie } });
    expect(ch.status).toBe(200);
    expect(await ch.json()).toEqual({
      charges: [{ event: 'tenant.charged', at: 'x', outcome: 'ok' }],
    });
    const pe = await server.request('/dashboard/api/payment-events', { headers: { cookie } });
    expect(pe.status).toBe(200);
    expect(await pe.json()).toEqual({
      events: [{ event: 'payment.webhook', at: 'x', outcome: 'ok' }],
    });
    const dn = await server.request('/dashboard/api/dunning', { headers: { cookie } });
    expect(dn.status).toBe(200);
    expect(await dn.json()).toEqual({
      events: [{ event: 'tenant.dunning', at: 'x', outcome: 'ok' }],
    });
    const br = await server.request('/dashboard/api/billing-runs', { headers: { cookie } });
    expect(br.status).toBe(200);
    expect(await br.json()).toEqual({
      runs: [{ event: 'billing.run', at: 'x', outcome: 'ok' }],
    });
    const rf = await server.request('/dashboard/api/refunds', { headers: { cookie } });
    expect(rf.status).toBe(200);
    expect(await rf.json()).toEqual({
      refunds: [{ event: 'tenant.refunded', at: 'x', outcome: 'ok' }],
    });
    const nf = await server.request('/dashboard/api/notifications', { headers: { cookie } });
    expect(nf.status).toBe(200);
    expect(await nf.json()).toEqual({
      notifications: [{ event: 'tenant.notified', at: 'x', outcome: 'ok' }],
    });
    const pc = await server.request('/dashboard/api/plan-changes', { headers: { cookie } });
    expect(pc.status).toBe(200);
    expect(await pc.json()).toEqual({
      planChanges: [{ event: 'tenant.plan_changed', at: 'x', outcome: 'ok' }],
    });
    const cg = await server.request('/dashboard/api/credit-grants', { headers: { cookie } });
    expect(cg.status).toBe(200);
    expect(await cg.json()).toEqual({
      creditGrants: [{ event: 'tenant.credit_granted', at: 'x', outcome: 'ok' }],
    });
    const ua = await server.request('/dashboard/api/usage-alerts', { headers: { cookie } });
    expect(ua.status).toBe(200);
    expect(await ua.json()).toEqual({
      usageAlerts: [{ event: 'tenant.usage_alert', at: 'x', outcome: 'ok' }],
    });
    const pl = await server.request('/dashboard/api/plans', { headers: { cookie } });
    expect(pl.status).toBe(200);
    expect(await pl.json()).toEqual({ plans: [{ id: 'pro', name: 'Pro', priceUsd: 49 }] });
    const st = await server.request('/dashboard/api/signup-tokens', { headers: { cookie } });
    expect(st.status).toBe(200);
    expect(await st.json()).toEqual({
      signupTokens: [{ slug: 'acme', status: 'pending', expiresAt: 'x', createdAt: 'y' }],
    });
    const ex = await server.request('/dashboard/api/exports', { headers: { cookie } });
    expect(ex.status).toBe(200);
    expect(await ex.json()).toEqual({
      exports: [{ event: 'tenant.exported', at: 'x', outcome: 'ok' }],
    });
    const rt = await server.request('/dashboard/api/retention', { headers: { cookie } });
    expect(rt.status).toBe(200);
    expect(await rt.json()).toEqual({
      generatedAt: 'x',
      retentionDays: 30,
      eligible: 0,
      pending: 0,
      tenants: [],
    });
    const is = await server.request('/dashboard/api/invoices-sent', { headers: { cookie } });
    expect(is.status).toBe(200);
    expect(await is.json()).toEqual({
      invoicesSent: [{ event: 'tenant.invoiced', at: 'x', outcome: 'ok' }],
    });
    const au = await server.request('/dashboard/api/audit', { headers: { cookie } });
    expect(au.status).toBe(200);
    expect(await au.json()).toEqual({
      events: [{ event: 'tenant.transition', at: 'x', outcome: 'ok' }],
    });
    const an = await server.request('/dashboard/api/audit-anomalies', { headers: { cookie } });
    expect(an.status).toBe(200);
    expect(await an.json()).toEqual({
      anomalies: [{ kind: 'error-spike', count: 12, events: ['tenant.charged'] }],
    });
    const ca = await server.request('/dashboard/api/cost-anomalies', { headers: { cookie } });
    expect(ca.status).toBe(200);
    expect(await ca.json()).toEqual({
      anomalies: [
        { kind: 'unprofitable', tenantId: 't1', costUsd: 30, priceUsd: 20, marginUsd: -10 },
      ],
    });
    // The panels require a session.
    expect((await server.request('/dashboard/api/cost')).status).toBe(401);
    expect((await server.request('/dashboard/api/reconcile')).status).toBe(401);
    expect((await server.request('/dashboard/api/reconcile-history')).status).toBe(401);
    expect((await server.request('/dashboard/api/invoices')).status).toBe(401);
    expect((await server.request('/dashboard/api/charges')).status).toBe(401);
    expect((await server.request('/dashboard/api/payment-events')).status).toBe(401);
    expect((await server.request('/dashboard/api/dunning')).status).toBe(401);
    expect((await server.request('/dashboard/api/billing-runs')).status).toBe(401);
    expect((await server.request('/dashboard/api/refunds')).status).toBe(401);
    expect((await server.request('/dashboard/api/notifications')).status).toBe(401);
    expect((await server.request('/dashboard/api/plan-changes')).status).toBe(401);
    expect((await server.request('/dashboard/api/credit-grants')).status).toBe(401);
    expect((await server.request('/dashboard/api/usage-alerts')).status).toBe(401);
    expect((await server.request('/dashboard/api/plans')).status).toBe(401);
    expect((await server.request('/dashboard/api/signup-tokens')).status).toBe(401);
    expect((await server.request('/dashboard/api/exports')).status).toBe(401);
    expect((await server.request('/dashboard/api/retention')).status).toBe(401);
    expect((await server.request('/dashboard/api/invoices-sent')).status).toBe(401);
    expect((await server.request('/dashboard/api/audit')).status).toBe(401);
    expect((await server.request('/dashboard/api/audit-anomalies')).status).toBe(401);
    expect((await server.request('/dashboard/api/cost-anomalies')).status).toBe(401);
  });

  it('rejects an invalid operator token (401) and sets no cookie', async () => {
    const res = await login(app(), 'wrong');
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('refuses the compliance panel without a session (401)', async () => {
    const res = await app().request('/dashboard/api/compliance');
    expect(res.status).toBe(401);
  });

  it('refuses a tampered session cookie (401, fail closed)', async () => {
    const server = app();
    const cookie = cookieOf(await login(server, TOKEN));
    const tampered = cookie.replace(/.$/, (ch) => (ch === 'a' ? 'b' : 'a')); // flip last char of the MAC
    const res = await server.request('/dashboard/api/compliance', {
      headers: { cookie: tampered },
    });
    expect(res.status).toBe(401);
  });

  it('/api/session reports the current principal and logout clears it', async () => {
    const server = app();
    expect((await server.request('/dashboard/api/session')).status).toBe(401);
    const cookie = cookieOf(await login(server, TOKEN));
    const who = await server.request('/dashboard/api/session', { headers: { cookie } });
    expect(await who.json()).toEqual({ id: 'default', role: 'admin' });
    const out = await server.request('/dashboard/api/session', {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(out.status).toBe(204);
  });

  it('does not mount the dashboard when no session secret is configured (404)', async () => {
    const server = createHttpServer(fakeTf({}), { token: TOKEN });
    expect((await server.request('/dashboard/api/session')).status).toBe(404);
  });
});

describe('dashboard reconcile execution (gated)', () => {
  const catalog = [{ version: '0001', sql: '-- 1' }];
  const report = { target: '0001', total: 1, alreadyAtLatest: 0, reconciled: ['t1'], partial: [] };
  const reconcileTf = () => fakeTf({ reconcileFleet: async () => report });

  /** Server with a reconcile catalog wired + the given operator credentials. */
  const execServer = (role: 'admin' | 'operator' | 'readonly', token: string) =>
    createHttpServer(reconcileTf(), {
      credentials: [{ id: role, role, token }],
      dashboardSecret: 'session-secret',
      dashboardReconcileCatalog: catalog,
    });

  it('reports capabilities (executable + mayExecute) for an admin', async () => {
    const server = execServer('admin', 'a');
    const cookie = cookieOf(await login(server, 'a'));
    const res = await server.request('/dashboard/api/reconcile/capabilities', {
      headers: { cookie },
    });
    expect(await res.json()).toEqual({ executable: true, mayExecute: true });
  });

  it('executes a reconcile for a tenant:provision holder (admin) and returns the report', async () => {
    const server = execServer('admin', 'a');
    const cookie = cookieOf(await login(server, 'a'));
    const res = await server.request('/dashboard/api/reconcile', {
      method: 'POST',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(report);
  });

  it('forbids execution for a readonly principal (403, deny by default)', async () => {
    const server = execServer('readonly', 'r');
    const cookie = cookieOf(await login(server, 'r'));
    const caps = await server.request('/dashboard/api/reconcile/capabilities', {
      headers: { cookie },
    });
    expect(await caps.json()).toEqual({ executable: true, mayExecute: false });
    const res = await server.request('/dashboard/api/reconcile', {
      method: 'POST',
      headers: { cookie },
    });
    expect(res.status).toBe(403);
  });

  it('requires a session for execution (401)', async () => {
    const server = execServer('admin', 'a');
    expect((await server.request('/dashboard/api/reconcile', { method: 'POST' })).status).toBe(401);
  });

  it('409s when no reconcile catalog is configured (execution disabled)', async () => {
    const server = createHttpServer(reconcileTf(), {
      token: 'a',
      dashboardSecret: 'session-secret',
    });
    const cookie = cookieOf(await login(server, 'a'));
    const caps = await server.request('/dashboard/api/reconcile/capabilities', {
      headers: { cookie },
    });
    expect(await caps.json()).toEqual({ executable: false, mayExecute: true });
    const res = await server.request('/dashboard/api/reconcile', {
      method: 'POST',
      headers: { cookie },
    });
    expect(res.status).toBe(409);
  });
});
