import { describe, expect, it } from 'vitest';
import { createHttpServer } from '../../src/app/http-server.js';
import { decodeCursor } from '../../src/core/index.js';
import { currentActor } from '../../src/app/actor-context.js';
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

  it('replays a POST response for a repeated Idempotency-Key (executes once)', async () => {
    let calls = 0;
    const server = app({
      provision: async () => {
        calls += 1;
        return { tenant, connectionUri: 'postgresql://secret@host/db' };
      },
    });
    const headers = { ...auth, 'Idempotency-Key': 'key-1' };
    const body = JSON.stringify({ slug: 'acme' });
    const first = await server.request('/v1/tenants', { method: 'POST', headers, body });
    const second = await server.request('/v1/tenants', { method: 'POST', headers, body });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get('Idempotency-Replayed')).toBe('true');
    // The retry replays the original body verbatim — including the once-only connection secret.
    expect(await second.json()).toEqual({
      tenant: tenantJson,
      connectionUri: 'postgresql://secret@host/db',
    });
    expect(calls).toBe(1); // executed once; the retry did not re-provision
  });

  it('rejects an Idempotency-Key reused with a different request (422)', async () => {
    const server = app({ provision: async () => ({ tenant, connectionUri: null }) });
    const headers = { ...auth, 'Idempotency-Key': 'key-2' };
    await server.request('/v1/tenants', {
      method: 'POST',
      headers,
      body: JSON.stringify({ slug: 'acme' }),
    });
    const res = await server.request('/v1/tenants', {
      method: 'POST',
      headers,
      body: JSON.stringify({ slug: 'different' }),
    });
    expect(res.status).toBe(422);
  });

  it('rejects an over-long Idempotency-Key (400)', async () => {
    const res = await app().request('/v1/tenants', {
      method: 'POST',
      headers: { ...auth, 'Idempotency-Key': 'x'.repeat(256) },
      body: JSON.stringify({ slug: 'acme' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 409 while a request with the same Idempotency-Key is in flight', async () => {
    const server = createHttpServer(
      fakeTf({ provision: async () => ({ tenant, connectionUri: null }) }),
      {
        token: TOKEN,
        idempotencyStore: {
          begin: () => Promise.resolve({ outcome: 'in_flight' as const }),
          complete: () => Promise.resolve(),
        },
      },
    );
    const res = await server.request('/v1/tenants', {
      method: 'POST',
      headers: { ...auth, 'Idempotency-Key': 'key-3' },
      body: JSON.stringify({ slug: 'acme' }),
    });
    expect(res.status).toBe(409);
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
    // Page not full (1 < default limit) → no next-page cursor.
    expect(await list.json()).toEqual({ tenants: [tenantJson], nextCursor: null });

    const bad = await app().request('/v1/tenants?status=bogus', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(bad.status).toBe(400);
  });

  it('serves the compliance report (tenant:read)', async () => {
    const result = { report: { inventory: { total: 0 } }, digest: 'abc123' };
    const res = await app({ complianceReport: async () => result as never }).request(
      '/v1/compliance/report',
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
  });

  it('serves the cost report (tenant:read) and 400s a bad period', async () => {
    const cost = {
      generatedAt: 'x',
      rows: [],
      unmetered: [],
      totals: { tenants: 0, costUsd: 0, priceUsd: 0, marginUsd: 0, unprofitable: 0, unpriced: 0 },
    };
    const server = app({ costReport: async () => cost });
    const ok = await server.request('/v1/cost/report', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(cost);
    const bad = await server.request('/v1/cost/report?from=not-a-date', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(bad.status).toBe(400);
  });

  it('serves fleet + per-tenant invoices (tenant:read) and 400s a bad date', async () => {
    const fleet = { generatedAt: 'x', invoices: [], unmetered: [] };
    const inv = {
      tenantId: 't1',
      periodStart: 'a',
      periodEnd: 'b',
      currency: 'USD',
      generatedAt: 'x',
      lineItems: [],
      totalUsd: 0,
    };
    const server = app({
      invoiceFleet: async () => fleet,
      invoice: async () => inv,
    });
    const f = await server.request('/v1/invoices', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(f.status).toBe(200);
    expect(await f.json()).toEqual(fleet);
    const one = await server.request('/v1/tenants/t1/invoice', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(one.status).toBe(200);
    expect(await one.json()).toEqual(inv);
    const bad = await server.request('/v1/invoices?to=nope', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(bad.status).toBe(400);
  });

  it('serves the fleet reconcile plan (read-only, tenant:read), honoring ?target', async () => {
    const plan = {
      target: '0003',
      perTenant: [{ tenantId: 't1', missing: ['0002', '0003'] }],
      pendingTenants: ['t1'],
      upToDate: [],
      totalMissing: 2,
      batches: [['t1']],
    };
    let seenTarget: string | undefined;
    const server = app({
      reconcilePlan: async (options) => {
        seenTarget = options?.targetVersion;
        return plan;
      },
    });
    const res = await server.request('/v1/fleet/reconcile?target=0003', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(plan);
    expect(seenTarget).toBe('0003');
  });

  it('serves reconcile history (tenant:read), 400 on a bad limit', async () => {
    const history = [{ event: 'fleet.reconcile', at: 'x', outcome: 'ok' }];
    const server = app({ reconcileHistory: async () => history as never });
    const ok = await server.request('/v1/fleet/reconcile/history', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ history });
    const bad = await server.request('/v1/fleet/reconcile/history?limit=0', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(bad.status).toBe(400);
  });

  it('serves charge history (tenant:read), 400 on a bad limit; charging is not over HTTP', async () => {
    const charges = [{ event: 'tenant.charged', at: 'x', outcome: 'ok' }];
    const server = app({ chargeHistory: async () => charges as never });
    const ok = await server.request('/v1/billing/charges', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ charges });
    const bad = await server.request('/v1/billing/charges?limit=-1', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(bad.status).toBe(400);
    // No charge endpoint is exposed (money movement is CLI/gated, not HTTP).
    const post = await server.request('/v1/billing/charges', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(post.status).toBe(404);
  });

  it('serves payment webhook-event history (tenant:read)', async () => {
    const events = [{ event: 'payment.webhook', at: 'x', outcome: 'ok' }];
    const server = app({ paymentWebhookHistory: async () => events as never });
    const ok = await server.request('/v1/billing/webhook-events', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ events });
  });

  it('ingests a signature-verified PSP webhook (no bearer), 400 on a bad signature', async () => {
    const seen: { raw: string; sig: string }[] = [];
    const server = createHttpServer(
      fakeTf({
        ingestPaymentWebhook: async (raw: string, sig: string) => {
          seen.push({ raw, sig });
          if (sig === 'bad') throw new Error('signature mismatch');
          return {
            id: 'evt_1',
            type: 'charge.succeeded',
            provider: 'stripe',
            rawType: 'x',
            occurredAt: 'x',
          } as never;
        },
      }),
      { token: TOKEN, paymentWebhooks: true },
    );
    // No bearer token — the signature is the auth.
    const ok = await server.request('/webhooks/payment', {
      method: 'POST',
      headers: { 'stripe-signature': 't=1,v1=abc', 'content-type': 'application/json' },
      body: '{"id":"evt_1"}',
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ received: true, type: 'charge.succeeded' });
    expect(seen[0]?.raw).toBe('{"id":"evt_1"}'); // the RAW body reached the verifier
    const bad = await server.request('/webhooks/payment', {
      method: 'POST',
      headers: { 'stripe-signature': 'bad' },
      body: '{}',
    });
    expect(bad.status).toBe(400);
  });

  it('does not mount the webhook endpoint unless enabled (404)', async () => {
    const res = await app().request('/webhooks/payment', { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });

  it('emits a keyset nextCursor on a full page and forwards it to the next request', async () => {
    const calls: Array<{ limit?: number; cursor?: { createdAt: Date; id: string } }> = [];
    const server = createHttpServer(
      fakeTf({
        listTenants: async (options) => {
          calls.push(options ?? {});
          return [tenant];
        },
      }),
      { token: TOKEN },
    );

    // limit=1 and one row returned → page is full → a next-page cursor is emitted.
    const first = await server.request('/v1/tenants?limit=1', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(first.status).toBe(200);
    const body = (await first.json()) as { tenants: unknown[]; nextCursor: string | null };
    expect(body.nextCursor).not.toBeNull();
    expect(decodeCursor(body.nextCursor!)).toEqual({ createdAt: tenant.createdAt, id: tenant.id });

    // The opaque token round-trips back through the query string into a keyset cursor.
    await server.request(`/v1/tenants?limit=1&cursor=${encodeURIComponent(body.nextCursor!)}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.cursor).toEqual({ createdAt: tenant.createdAt, id: tenant.id });
  });

  it('runs authenticated handlers within the operator audit context (principal as actor)', async () => {
    let seen: unknown = 'unset';
    const res = await app({
      listTenants: async () => {
        seen = currentActor();
        return [];
      },
    }).request('/v1/tenants', { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    // The default token credential authenticates as the `default` admin principal.
    expect(seen).toEqual({ id: 'default', role: 'admin' });
  });

  it('rejects a malformed cursor (400)', async () => {
    const res = await app({ listTenants: async () => [] }).request(
      '/v1/tenants?cursor=not-a-valid-cursor',
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(400);
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
      suspend: async () => tenant,
      purge: async () => tenant,
    });
  const creds = [
    { id: 'alice', token: 'tok-admin', role: 'admin' as const },
    { id: 'bob', token: 'tok-read', role: 'readonly' as const },
    { id: 'carol', token: 'tok-op', role: 'operator' as const },
    {
      id: 'dave',
      token: 'tok-scoped',
      role: 'operator' as const,
      permissions: ['tenant:read'] as const,
    },
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

  it('lets an operator run the lifecycle but forbids the irreversible purge (403)', async () => {
    const opAuth = { authorization: 'Bearer tok-op', 'content-type': 'application/json' };
    // operator holds tenant:provision …
    const provisioned = await server().request('/v1/tenants', {
      method: 'POST',
      headers: opAuth,
      body: JSON.stringify({ slug: 'acme' }),
    });
    expect(provisioned.status).toBe(201);
    // … and tenant:suspend …
    expect(
      (await server().request('/v1/tenants/t1/suspend', { method: 'POST', headers: opAuth }))
        .status,
    ).toBe(200);
    // … but NOT tenant:purge (deny by default for the irreversible op).
    const purge = await server().request('/v1/tenants/t1/purge', {
      method: 'POST',
      headers: opAuth,
      body: JSON.stringify({ confirm: true }),
    });
    expect(purge.status).toBe(403);
  });

  it('honors an explicit permission set that scopes an operator down (read-only)', async () => {
    const scopedAuth = { authorization: 'Bearer tok-scoped', 'content-type': 'application/json' };
    // dave is an `operator` but explicitly scoped to tenant:read only → may read, not provision.
    expect((await server().request('/v1/tenants', { headers: scopedAuth })).status).toBe(200);
    const res = await server().request('/v1/tenants', {
      method: 'POST',
      headers: scopedAuth,
      body: JSON.stringify({ slug: 'acme' }),
    });
    expect(res.status).toBe(403);
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
