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
      fleetStatus: async () => drift,
      costReport: async () => cost,
      reconcilePlan: async () => reconcile,
      reconcileHistory: async () => [{ event: 'fleet.reconcile', at: 'x', outcome: 'ok' }] as never,
      invoiceFleet: async () => invoices,
      chargeHistory: async () => [{ event: 'tenant.charged', at: 'x', outcome: 'ok' }] as never,
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
    // The panels require a session.
    expect((await server.request('/dashboard/api/cost')).status).toBe(401);
    expect((await server.request('/dashboard/api/reconcile')).status).toBe(401);
    expect((await server.request('/dashboard/api/reconcile-history')).status).toBe(401);
    expect((await server.request('/dashboard/api/invoices')).status).toBe(401);
    expect((await server.request('/dashboard/api/charges')).status).toBe(401);
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
