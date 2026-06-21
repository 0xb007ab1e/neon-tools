import { describe, expect, it } from 'vitest';
import { createPortal } from '../../src/app/portal.js';
import type { TenantForge, TenantSummary } from '../../src/app/lib.js';
import type { TenantEvent } from '../../src/core/index.js';
import type { TenantAuthenticator } from '../../src/ports/tenant-authenticator.js';

const SECRET = 'portal-session-secret';

const summaries: Record<string, TenantSummary> = {
  't-a': {
    id: 't-a',
    slug: 'acme',
    region: 'aws-us-east-1',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    planPriceUsd: 9,
  },
};
const chargesByTenant: Record<string, TenantEvent[]> = {
  't-a': [
    {
      event: 'tenant.charged',
      at: '2026-06-20T00:00:00.000Z',
      outcome: 'ok',
      tenantId: 't-a',
      context: { chargeId: 'ch_a', amountMinor: 900, currency: 'usd', status: 'succeeded' },
    },
  ],
};

const receiptsByTenant: Record<string, TenantEvent[]> = {
  't-a': [
    {
      event: 'tenant.notified',
      at: '2026-06-20T06:00:00.000Z',
      outcome: 'ok',
      tenantId: 't-a',
      context: { provider: 'log', kind: 'charge', reference: 'ch_a', status: 'queued' },
    },
  ],
};

/** A fake TenantForge exposing only the tenant-scoped reads the portal uses. */
const fakeTf = (): TenantForge =>
  ({
    tenantSummary: (id: string) => Promise.resolve(summaries[id] ?? null),
    tenantCharges: (id: string) => Promise.resolve(chargesByTenant[id] ?? []),
    tenantRefunds: () => Promise.resolve([]),
    tenantNotifications: (id: string) => Promise.resolve(receiptsByTenant[id] ?? []),
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
  }) as unknown as TenantForge;

/** A token authenticator: `tok-a` → t-a. */
const auth: TenantAuthenticator = {
  authenticate: (token: string) => Promise.resolve(token === 'tok-a' ? { tenantId: 't-a' } : null),
};

const portal = (): ReturnType<typeof createPortal> =>
  createPortal({ tf: fakeTf(), authenticator: auth, sessionSecret: SECRET });

/** Log in with a portal token and return the session cookie pair. */
async function login(app: ReturnType<typeof createPortal>, token: string): Promise<string> {
  const res = await app.request('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
  });
  return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
}

describe('createPortal', () => {
  it('serves the login page when signed out (semantic, accessible HTML)', async () => {
    const res = await portal().request('/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<label for="token">'); // input is labelled
    expect(html).toContain('Sign in');
  });

  it('rejects a bad token (401) and sets no session cookie', async () => {
    const res = await portal().request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'wrong' }).toString(),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.text()).toContain('Invalid token');
  });

  it('logs in and renders only the signed-in tenant’s own account + charges', async () => {
    const app = portal();
    const cookie = await login(app, 'tok-a');
    expect(cookie).toContain('tf_portal=');
    const res = await app.request('/', { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('acme'); // own slug
    expect(html).toContain('Recent charges');
    expect(html).toContain('<caption>Recent charges</caption>'); // accessible table
    expect(html).toContain('900 usd');
    expect(html).toContain('$9 / period');
    // Usage section renders (humanized), and the internal Neon project id is never exposed.
    expect(html).toContain('Usage this period');
    expect(html).not.toContain('proj'); // neonProjectId is not leaked to the tenant
    // Receipts render (the tenant's own notification history).
    expect(html).toContain('<caption>Recent receipts</caption>');
    expect(html).toContain('ch_a');
  });

  it('JSON endpoints are scoped to the session tenant; 401 without a session', async () => {
    const app = portal();
    expect((await app.request('/api/me')).status).toBe(401);
    expect((await app.request('/api/charges')).status).toBe(401);
    expect((await app.request('/api/refunds')).status).toBe(401);
    expect((await app.request('/api/receipts')).status).toBe(401);
    expect((await app.request('/api/usage')).status).toBe(401);

    const cookie = await login(app, 'tok-a');
    const me = await app.request('/api/me', { headers: { cookie } });
    expect(me.status).toBe(200);
    expect((await me.json()) as TenantSummary).toMatchObject({ id: 't-a', slug: 'acme' });
    const charges = await app.request('/api/charges', { headers: { cookie } });
    expect(
      ((await charges.json()) as { charges: TenantEvent[] }).charges[0]?.context?.chargeId,
    ).toBe('ch_a');
    const receipts = await app.request('/api/receipts', { headers: { cookie } });
    expect(receipts.status).toBe(200);
    expect(
      ((await receipts.json()) as { receipts: TenantEvent[] }).receipts[0]?.context?.reference,
    ).toBe('ch_a');
    const usage = await app.request('/api/usage', { headers: { cookie } });
    expect(usage.status).toBe(200);
    const usageBody = (await usage.json()) as Record<string, unknown>;
    expect(usageBody).toMatchObject({ tenantId: 't-a' });
    expect(usageBody).not.toHaveProperty('neonProjectId'); // infra id projected away
  });

  it('there is no way to ask for another tenant — the portal never reads a tenant id from the request', async () => {
    const app = portal();
    const cookie = await login(app, 'tok-a');
    // Query/path attempts to name another tenant are ignored; the session tenant is always used.
    const res = await app.request('/api/me?tenantId=t-b', { headers: { cookie } });
    expect((await res.json()) as TenantSummary).toMatchObject({ id: 't-a' });
  });

  it('a tampered session cookie is rejected (fail closed)', async () => {
    const app = portal();
    const cookie = await login(app, 'tok-a');
    const tampered = `${cookie.split('.')[0]}.deadbeef`;
    const res = await app.request('/api/me', { headers: { cookie: tampered } });
    expect(res.status).toBe(401);
  });

  it('logout clears the session', async () => {
    const app = portal();
    const cookie = await login(app, 'tok-a');
    const out = await app.request('/logout', { method: 'POST', headers: { cookie } });
    expect(out.status).toBe(303);
    // The cleared cookie has an empty value / past expiry.
    expect(out.headers.get('set-cookie') ?? '').toMatch(/tf_portal=;|Max-Age=0/i);
  });
});
