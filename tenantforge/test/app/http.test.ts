import { describe, expect, it } from 'vitest';
import { createHttpServer } from '../../src/app/http-server.js';
import type { TenantRecord } from '../../src/core/domain.js';
import type { TenantForge } from '../../src/app/lib.js';

const TOKEN = 'test-token';
const fakeTf = (overrides: Partial<TenantForge>): TenantForge =>
  overrides as unknown as TenantForge;
const app = (overrides: Partial<TenantForge> = {}) =>
  createHttpServer(fakeTf(overrides), { token: TOKEN });
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

const tenant: TenantRecord = {
  id: 't1',
  slug: 'acme',
  region: 'aws-us-east-1',
  status: 'active',
  neonProjectId: 'proj-1',
  metadata: {},
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

// How the record looks after JSON serialization over the wire (Date -> ISO string).
const tenantJson = JSON.parse(JSON.stringify(tenant)) as unknown;

describe('HTTP control-plane', () => {
  it('serves /health without auth', async () => {
    const res = await app().request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', tool: 'tenantforge' });
  });

  it('serves /ready (200) without auth when dependencies are healthy', async () => {
    const res = await app({
      health: async () => ({ status: 'ok', checks: { registry: 'ok' } }),
    }).request('/ready');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', checks: { registry: 'ok' } });
  });

  it('returns 503 from /ready when a dependency is degraded', async () => {
    const res = await app({
      health: async () => ({ status: 'degraded', checks: { registry: 'error' } }),
    }).request('/ready');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: 'degraded' });
  });

  it('serves /metrics as Prometheus text when wired', async () => {
    const server = createHttpServer(fakeTf({}), {
      token: TOKEN,
      metrics: () => 'tenantforge_events_total{event="x",outcome="ok"} 1\n',
    });
    const res = await server.request('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toContain('tenantforge_events_total');
  });

  it('does not mount /metrics when not wired (404)', async () => {
    const res = await app().request('/metrics');
    expect(res.status).toBe(404);
  });

  it('rejects /v1 routes without a bearer token (401)', async () => {
    const res = await app().request('/v1/tenants');
    expect(res.status).toBe(401);
  });

  it('rejects /v1 routes with a wrong bearer token (401)', async () => {
    const res = await app().request('/v1/tenants', {
      headers: { authorization: 'Bearer not-the-token' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects an over-large request body (413)', async () => {
    const huge = JSON.stringify({ slug: 'acme', metadata: { blob: 'x'.repeat(1024 * 1024 + 16) } });
    const res = await app().request('/v1/tenants', { method: 'POST', headers: auth, body: huge });
    expect(res.status).toBe(413);
  });

  it('provisions a tenant (201) and returns the connection secret to the authed caller', async () => {
    const res = await app({
      provision: async () => ({ tenant, connectionUri: 'postgresql://secret@host/db' }),
    }).request('/v1/tenants', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ slug: 'acme' }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      tenant: tenantJson,
      connectionUri: 'postgresql://secret@host/db',
    });
  });

  it('returns RFC 9457 problem+json on validation failure (400)', async () => {
    const res = await app().request('/v1/tenants', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ region: 'aws-us-east-1' }), // missing slug
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(await res.json()).toMatchObject({ title: 'Validation failed', status: 400 });
  });

  it('maps an invalid slug to 400', async () => {
    const res = await app({
      provision: async () => {
        throw new Error('invalid tenant slug "a": must be 3–63 chars');
      },
    }).request('/v1/tenants', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ slug: 'a' }),
    });
    expect(res.status).toBe(400);
  });

  it('lists tenants and rejects an unknown status filter (400)', async () => {
    const list = await app({ listTenants: async () => [tenant] }).request('/v1/tenants', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ tenants: [tenantJson] });

    const bad = await app().request('/v1/tenants?status=bogus', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(bad.status).toBe(400);
  });

  it('gets a tenant, 404 when missing', async () => {
    const ok = await app({ getTenant: async () => tenant }).request('/v1/tenants/t1', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);

    const missing = await app({ getTenant: async () => null }).request('/v1/tenants/nope', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(missing.status).toBe(404);
  });

  it('suspends; maps an illegal transition to 409', async () => {
    const ok = await app({ suspend: async () => ({ ...tenant, status: 'suspended' }) }).request(
      '/v1/tenants/t1/suspend',
      { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ tenant: { status: 'suspended' } });

    const conflict = await app({
      suspend: async () => {
        throw new Error('illegal tenant status transition: deleted → suspended');
      },
    }).request('/v1/tenants/t1/suspend', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(conflict.status).toBe(409);
  });

  it('offboards (archive, reversible) — no confirm needed; returns the archive ref', async () => {
    const res = await app({
      offboard: async () => ({
        tenant: { ...tenant, status: 'offboarding' },
        archive: { location: 'neon-project:proj-1' },
      }),
    }).request('/v1/tenants/t1/offboard', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      tenant: { status: 'offboarding' },
      archive: { location: 'neon-project:proj-1' },
    });
  });

  it('requires confirm:true to purge (400 without it)', async () => {
    const res = await app().request('/v1/tenants/t1/purge', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({}), // no confirm
    });
    expect(res.status).toBe(400);
  });

  it('purges with confirm:true', async () => {
    const res = await app({
      purge: async () => ({ ...tenant, status: 'deleted' }),
    }).request('/v1/tenants/t1/purge', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ confirm: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tenant: { status: 'deleted' } });
  });

  it('maps a missing tenant to 404 on purge', async () => {
    const res = await app({
      purge: async () => {
        throw new Error('tenant nope not found');
      },
    }).request('/v1/tenants/nope/purge', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ confirm: true }),
    });
    expect(res.status).toBe(404);
  });
});

describe('HTTP per-operator auth + RBAC', () => {
  const tenant: TenantRecord = {
    id: 't1',
    slug: 'acme',
    region: 'aws-us-east-1',
    status: 'active',
    neonProjectId: 'proj-1',
    metadata: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const tf = (): TenantForge =>
    fakeTf({
      listTenants: async () => [tenant],
      provision: async () => ({ tenant, connectionUri: 'postgresql://secret@host/db' }),
    });
  const creds = [
    { id: 'alice', token: 'tok-admin', role: 'admin' as const },
    { id: 'bob', token: 'tok-read', role: 'readonly' as const },
  ];
  const server = () => createHttpServer(tf(), { credentials: creds });

  it('rejects an unknown token (401) and accepts each operator’s own token', async () => {
    expect(
      (await server().request('/v1/tenants', { headers: { authorization: 'Bearer nope' } })).status,
    ).toBe(401);
    expect(
      (await server().request('/v1/tenants', { headers: { authorization: 'Bearer tok-admin' } }))
        .status,
    ).toBe(200);
    expect(
      (await server().request('/v1/tenants', { headers: { authorization: 'Bearer tok-read' } }))
        .status,
    ).toBe(200);
  });

  it('lets a readonly operator GET but forbids mutations (403)', async () => {
    const readAuth = { authorization: 'Bearer tok-read', 'content-type': 'application/json' };
    expect((await server().request('/v1/tenants', { headers: readAuth })).status).toBe(200);
    const res = await server().request('/v1/tenants', {
      method: 'POST',
      headers: readAuth,
      body: JSON.stringify({ slug: 'acme' }),
    });
    expect(res.status).toBe(403);
  });

  it('lets an admin operator mutate (201)', async () => {
    const res = await server().request('/v1/tenants', {
      method: 'POST',
      headers: { authorization: 'Bearer tok-admin', 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'acme' }),
    });
    expect(res.status).toBe(201);
  });

  it('refuses to start with no authenticator, credential, or token (fail closed)', () => {
    expect(() => createHttpServer(tf(), {})).toThrow(
      /an authenticator, credentials, or a token is required/,
    );
  });
});

describe('HTTP with an injected authenticator (e.g. OIDC)', () => {
  const tf = (): TenantForge => fakeTf({ listTenants: async () => [] });
  // A stand-in authenticator: any token equal to "jwt-admin" is an admin principal.
  const authenticator = {
    authenticate: (bearerToken: string) =>
      Promise.resolve(
        bearerToken === 'jwt-admin' ? { id: 'oidc-alice', role: 'admin' as const } : null,
      ),
  };
  const server = () => createHttpServer(tf(), { authenticator });

  it('authenticates via the injected authenticator (200) and rejects others (401)', async () => {
    expect(
      (await server().request('/v1/tenants', { headers: { authorization: 'Bearer jwt-admin' } }))
        .status,
    ).toBe(200);
    expect(
      (await server().request('/v1/tenants', { headers: { authorization: 'Bearer other' } }))
        .status,
    ).toBe(401);
  });
});

describe('HTTP rate limiting (per principal, fixed window)', () => {
  const server = (nowRef: { t: number }) =>
    createHttpServer(fakeTf({ listTenants: async () => [] }), {
      token: 'tok',
      rateLimit: { limit: 2, windowMs: 1000 },
      now: () => nowRef.t,
    });
  const hdr = { authorization: 'Bearer tok' };

  it('allows up to the limit, then returns 429 with Retry-After, and resets after the window', async () => {
    const nowRef = { t: 0 };
    const app = server(nowRef);
    expect((await app.request('/v1/tenants', { headers: hdr })).status).toBe(200);
    expect((await app.request('/v1/tenants', { headers: hdr })).status).toBe(200);
    const limited = await app.request('/v1/tenants', { headers: hdr });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('1');
    // After the window elapses, the budget refills.
    nowRef.t = 1000;
    expect((await app.request('/v1/tenants', { headers: hdr })).status).toBe(200);
  });
});
