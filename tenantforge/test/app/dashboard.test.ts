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
const app = () =>
  createHttpServer(
    fakeTf({
      complianceReport: async () => report as never,
      fleetStatus: async () => drift,
      costReport: async () => cost,
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
    // Both panels require a session.
    expect((await server.request('/dashboard/api/cost')).status).toBe(401);
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
