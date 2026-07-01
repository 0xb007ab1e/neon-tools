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

  // #17 — optional Bearer token on /metrics (defense-in-depth over network isolation).
  const METRICS = 'tenantforge_events_total{event="x",outcome="ok"} 1\n';
  const metricsServer = (metricsToken?: string) =>
    createHttpServer(fakeTf({}), {
      token: TOKEN,
      metrics: () => METRICS,
      ...(metricsToken !== undefined ? { metricsToken } : {}),
    });

  it('serves /metrics unauthenticated when no token is configured (default scraping unbroken)', async () => {
    const res = await metricsServer().request('/metrics');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('tenantforge_events_total');
  });

  it('401s /metrics without a bearer token when a token is configured', async () => {
    const res = await metricsServer('metrics-secret').request('/metrics');
    expect(res.status).toBe(401);
  });

  it('401s /metrics with the wrong bearer token when a token is configured', async () => {
    const res = await metricsServer('metrics-secret').request('/metrics', {
      headers: { authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
  });

  it('200s /metrics with the correct bearer token when a token is configured', async () => {
    const res = await metricsServer('metrics-secret').request('/metrics', {
      headers: { authorization: 'Bearer metrics-secret' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('tenantforge_events_total');
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

  it('imports an existing project (201) and does NOT echo the supplied connection secret', async () => {
    let received: { neonProjectId: string; connectionUri: string } | undefined;
    const res = await app({
      importTenant: async (input) => {
        received = { neonProjectId: input.neonProjectId, connectionUri: input.connectionUri };
        return { tenant };
      },
    }).request('/v1/tenants/import', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        slug: 'acme',
        neonProjectId: 'existing-1',
        connectionUri: 'postgresql://owner@host/db',
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toEqual({ tenant: tenantJson }); // tenant only — no connectionUri in the response
    expect(json.connectionUri).toBeUndefined();
    // The inbound secret reached the service (to be stored), but is never returned.
    expect(received).toEqual({
      neonProjectId: 'existing-1',
      connectionUri: 'postgresql://owner@host/db',
    });
  });

  it('maps an already-in-use slug on import to 409 Conflict', async () => {
    const res = await app({
      importTenant: async () => {
        throw new Error('slug "acme" is already in use (status: active)');
      },
    }).request('/v1/tenants/import', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        slug: 'acme',
        neonProjectId: 'p',
        connectionUri: 'postgresql://x@h/d',
      }),
    });
    expect(res.status).toBe(409);
  });

  it('creates a webhook subscription (201) returning the signing secret once', async () => {
    const created = {
      id: 'sub-1',
      url: 'https://hook.test/x',
      secret: 'the-signing-secret',
      eventTypes: [],
      createdAt: 'x',
    };
    const res = await app({ createWebhookSubscription: async () => created }).request(
      '/v1/webhook-subscriptions',
      { method: 'POST', headers: auth, body: JSON.stringify({ url: 'https://hook.test/x' }) },
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: 'sub-1', secret: 'the-signing-secret' });
  });

  it('400s a non-https webhook subscription URL', async () => {
    const res = await app({
      createWebhookSubscription: async () => {
        throw new Error('webhook subscription url must use TLS (https://) — got "http://".');
      },
    }).request('/v1/webhook-subscriptions', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ url: 'http://hook.test/x' }),
    });
    expect(res.status).toBe(400);
  });

  it('lists webhook subscriptions (never the secret)', async () => {
    const res = await app({
      listWebhookSubscriptions: async () =>
        [
          { id: 's1', url: 'https://hook.test/x', eventTypes: [], active: true, createdAt: 'x' },
        ] as never,
    }).request('/v1/webhook-subscriptions', { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subscriptions: unknown[] };
    expect(body.subscriptions).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('deletes a webhook subscription (204) and 404s an unknown id', async () => {
    const ok = await app({ deleteWebhookSubscription: async () => true }).request(
      '/v1/webhook-subscriptions/s1',
      { method: 'DELETE', headers: auth },
    );
    expect(ok.status).toBe(204);
    const missing = await app({ deleteWebhookSubscription: async () => false }).request(
      '/v1/webhook-subscriptions/nope',
      { method: 'DELETE', headers: auth },
    );
    expect(missing.status).toBe(404);
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

  it('serves the operator digest (tenant:read, read-only)', async () => {
    const digest = { severity: 'ok', headline: 'ok: all clear', totalIssues: 0, categories: [] };
    const res = await app({ operatorDigest: async () => digest as never }).request(
      '/v1/operator/digest',
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ severity: 'ok' });
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

  it('previews a plan change (tenant:read); 400 without a valid price; applying is not over HTTP', async () => {
    const preview = {
      tenantId: 't1',
      oldPriceUsd: 10,
      newPriceUsd: 20,
      period: { from: 'a', to: 'b' },
      proratedDeltaMinor: 500,
    };
    const server = app({ previewPlanChange: async () => preview });
    const ok = await server.request('/v1/tenants/t1/plan/preview?price=20', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(preview);
    const bad = await server.request('/v1/tenants/t1/plan/preview', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(bad.status).toBe(400);
    // No apply/change endpoint over HTTP (mutation + optional money — CLI only).
    const post = await server.request('/v1/tenants/t1/plan/preview', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(post.status).toBe(404);
  });

  it("serves a tenant's credit balance + ledger (tenant:read); granting is not over HTTP", async () => {
    const entries = [{ tenantId: 't1', amountMinor: 1000, currency: 'usd', reason: 'x', at: 'y' }];
    const server = app({
      creditBalance: async () => 1000,
      creditHistory: async () => entries,
    });
    const ok = await server.request('/v1/tenants/t1/credit', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      tenantId: 't1',
      currency: 'usd',
      balanceMinor: 1000,
      entries,
    });
    // No grant endpoint over HTTP (granting credit is a CLI/gated op).
    const post = await server.request('/v1/tenants/t1/credit', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(post.status).toBe(404);
  });

  it('serves the retention report (tenant:read) and 400s on a negative window', async () => {
    const report = { generatedAt: 'x', retentionDays: 30, eligible: 1, pending: 0, tenants: [] };
    let captured: unknown;
    const server = app({
      retentionReport: async (opts) => {
        captured = opts;
        return report;
      },
    });
    const ok = await server.request('/v1/retention?retention-days=7', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(report);
    expect(captured).toEqual({ retentionDays: 7 });
    const bad = await server.request('/v1/retention?retention-days=-1', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(bad.status).toBe(400);
  });

  it('serves data-export history (tenant:read); exporting is not over HTTP', async () => {
    const exports = [{ event: 'tenant.exported', at: 'x', outcome: 'ok' }];
    const server = app({ exportHistory: async () => exports as never });
    const ok = await server.request('/v1/exports', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ exports });
  });

  it('queries the audit trail (tenant:read), passing filters, and 400s on a bad limit', async () => {
    const events = [{ event: 'tenant.charged', at: 'x', outcome: 'ok', tenantId: 't1' }];
    let captured: unknown;
    const server = app({
      queryAudit: async (q) => {
        captured = q;
        if ((q?.limit ?? 50) < 1) throw new Error('audit query: limit must be a positive integer');
        return events as never;
      },
    });
    const ok = await server.request('/v1/audit?event=tenant.charged&tenant=t1&limit=10', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ events });
    expect(captured).toEqual({ events: ['tenant.charged'], tenantId: 't1', limit: 10 });
    const bad = await server.request('/v1/audit?limit=0', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(bad.status).toBe(400);
  });

  it('scans the audit trail for anomalies (tenant:read)', async () => {
    const anomalies = [{ kind: 'error-spike', count: 12, events: ['tenant.charged'] }];
    const server = app({ scanAuditAnomalies: async () => anomalies as never });
    const ok = await server.request('/v1/audit/anomalies', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ anomalies });
  });

  it('serves invoice-delivery history (tenant:read); sending is not over HTTP', async () => {
    const invoicesSent = [{ event: 'tenant.invoiced', at: 'x', outcome: 'ok' }];
    const server = app({ invoiceDeliveryHistory: async () => invoicesSent as never });
    const ok = await server.request('/v1/billing/invoices-sent', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ invoicesSent });
  });

  it('scans cost anomalies (tenant:read), passing threshold query params', async () => {
    const anomalies = [
      { kind: 'unprofitable', tenantId: 't1', costUsd: 30, priceUsd: 20, marginUsd: -10 },
    ];
    let captured: unknown;
    const server = app({
      scanCostAnomalies: async (_period, thresholds) => {
        captured = thresholds;
        return anomalies as never;
      },
    });
    const ok = await server.request('/v1/cost/anomalies?min-margin=5&max-cost=100', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ anomalies });
    expect(captured).toEqual({ minMarginUsd: 5, maxCostUsd: 100 });
  });

  it('serves signup-token status (tenant:read); issue/redeem are not over HTTP', async () => {
    const signupTokens = [{ slug: 'acme', status: 'pending', expiresAt: 'x', createdAt: 'y' }];
    const server = app({ listSignupTokens: async () => signupTokens as never });
    const ok = await server.request('/v1/signup-tokens', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ signupTokens });
  });

  it('serves the plan catalog (tenant:read); assigning is not over HTTP', async () => {
    const catalog = [{ id: 'pro', name: 'Pro', priceUsd: 49 }];
    const server = app({ listPlans: () => catalog });
    const ok = await server.request('/v1/plans', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ plans: catalog });
  });

  it('serves usage-alert history (tenant:read); the live sweep is not over HTTP', async () => {
    const alerts = [{ event: 'tenant.usage_alert', at: 'x', outcome: 'ok' }];
    const server = app({ usageAlertHistory: async () => alerts as never });
    const ok = await server.request('/v1/usage-alerts', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ alerts });
  });

  it('serves plan-change history (tenant:read)', async () => {
    const planChanges = [{ event: 'tenant.plan_changed', at: 'x', outcome: 'ok' }];
    const server = app({ planChangeHistory: async () => planChanges as never });
    const ok = await server.request('/v1/billing/plan-changes', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ planChanges });
  });

  it('serves billing-receipt notification history (tenant:read)', async () => {
    const notifications = [{ event: 'tenant.notified', at: 'x', outcome: 'ok' }];
    const server = app({ notificationHistory: async () => notifications as never });
    const ok = await server.request('/v1/billing/notifications', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ notifications });
  });

  it('serves refund history (tenant:read); issuing a refund is not over HTTP', async () => {
    const refunds = [{ event: 'tenant.refunded', at: 'x', outcome: 'ok' }];
    const server = app({ refundHistory: async () => refunds as never });
    const ok = await server.request('/v1/billing/refunds', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ refunds });
    // No refund endpoint (it returns real money — CLI/gated only).
    const post = await server.request('/v1/billing/refunds', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(post.status).toBe(404);
  });

  it('serves billing-run history (tenant:read); the run itself is not over HTTP', async () => {
    const runs = [{ event: 'billing.run', at: 'x', outcome: 'ok' }];
    const server = app({ billingRunHistory: async () => runs as never });
    const ok = await server.request('/v1/billing/runs', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ runs });
    // No billing-run endpoint (it charges the fleet + suspends — CLI/gated only).
    const post = await server.request('/v1/billing/runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(post.status).toBe(404);
  });

  it('serves dunning history (tenant:read), 400 on a bad limit; the run is not over HTTP', async () => {
    const events = [{ event: 'tenant.dunning', at: 'x', outcome: 'ok' }];
    const server = app({ dunningHistory: async () => events as never });
    const ok = await server.request('/v1/billing/dunning', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ events });
    const bad = await server.request('/v1/billing/dunning?limit=0', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(bad.status).toBe(400);
    // No dunning-run endpoint (it moves money + suspends — CLI/gated only).
    const post = await server.request('/v1/billing/dunning', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(post.status).toBe(404);
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

  it('restores an offboarded tenant (POST /restore → active)', async () => {
    const res = await app({
      restore: async () => ({ ...tenant, status: 'active' }),
    }).request('/v1/tenants/t1/restore', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tenant: { status: 'active' } });
  });

  it('maps a past-retention restore to 409 Conflict', async () => {
    const res = await app({
      restore: async () => {
        throw new Error('tenant is past its retention window (eligible for purge); cannot restore');
      },
    }).request('/v1/tenants/t1/restore', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(409);
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

describe('HTTP evidence retrieval surface (ADR-0011 Phase 3b — operator-only)', () => {
  const manifest = {
    bundleId: 'bid-abc',
    scope: 'fleet' as const,
    generatedAt: '2026-06-25T00:00:00.000Z',
    storedAt: '2026-06-25T00:00:01.000Z',
    signerKid: 'tenantforge-evidence-bundle',
    contentHashes: {
      inventory: 'h1',
      isolation: 'h2',
      residency: 'h3',
      auditExcerpt: 'h4',
      erasureCertificates: 'h5',
    },
  };
  const signed = {
    bundle: { scope: 'fleet' as const, generatedAt: '2026-06-25T00:00:00.000Z' },
    jws: 'eyJhbGciOiJFZERTQSJ9.payload.sig',
  };
  const publicJwk = { kty: 'OKP', crv: 'Ed25519', x: 'PUBLIC_KEY_BYTES' };
  const tf = (over: Partial<TenantForge> = {}): TenantForge =>
    fakeTf({
      evidenceList: async () => [manifest] as never,
      evidenceGet: async (id: string) => (id === 'bid-abc' ? (signed as never) : null),
      evidenceBundlePublicKey: async () => publicJwk,
      ...over,
    });
  // alice=admin, bob=readonly, carol=operator.
  const creds = [
    { id: 'alice', token: 'tok-admin', role: 'admin' as const },
    { id: 'bob', token: 'tok-read', role: 'readonly' as const },
    { id: 'carol', token: 'tok-op', role: 'operator' as const },
  ];
  const server = (over: Partial<TenantForge> = {}) =>
    createHttpServer(tf(over), { credentials: creds });
  const opAuth = { authorization: 'Bearer tok-op' };

  it('GET /v1/evidence/public-key needs NO auth and returns ONLY the public JWK (no private d)', async () => {
    const res = await server().request('/v1/evidence/public-key');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { publicKey: Record<string, unknown> };
    expect(body.publicKey).toMatchObject({ kty: 'OKP', crv: 'Ed25519' });
    // The private scalar `d` must NEVER appear.
    expect(JSON.stringify(body)).not.toContain('"d"');
    expect(body.publicKey).not.toHaveProperty('d');
  });

  it('GET /v1/evidence/public-key returns 404 when no signer is configured', async () => {
    const res = await server({ evidenceBundlePublicKey: async () => null }).request(
      '/v1/evidence/public-key',
    );
    expect(res.status).toBe(404);
  });

  it('unauthenticated → 401 on list + get', async () => {
    expect((await server().request('/v1/evidence/bundles')).status).toBe(401);
    expect((await server().request('/v1/evidence/bundles/bid-abc')).status).toBe(401);
  });

  it('a readonly operator is FORBIDDEN (403) — evidence retrieval is operator-gated, not any reader', async () => {
    const ro = { authorization: 'Bearer tok-read' };
    const list = await server().request('/v1/evidence/bundles', { headers: ro });
    expect(list.status).toBe(403);
    const get = await server().request('/v1/evidence/bundles/bid-abc', { headers: ro });
    expect(get.status).toBe(403);
  });

  it('an operator can list (200, facts only) and fetch (200, the signed bundle)', async () => {
    const list = await server().request('/v1/evidence/bundles', { headers: opAuth });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { manifests: unknown[] };
    expect(listBody.manifests).toHaveLength(1);
    // The list response carries no JWS body.
    expect(JSON.stringify(listBody)).not.toContain('eyJ');
    const get = await server().request('/v1/evidence/bundles/bid-abc', { headers: opAuth });
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ bundle: signed.bundle, jws: signed.jws });
  });

  it('an admin can also retrieve (200)', async () => {
    const res = await server().request('/v1/evidence/bundles', {
      headers: { authorization: 'Bearer tok-admin' },
    });
    expect(res.status).toBe(200);
  });

  it('a fetch of an unknown id is a uniform 404 (no existence oracle)', async () => {
    const res = await server().request('/v1/evidence/bundles/does-not-exist', { headers: opAuth });
    expect(res.status).toBe(404);
  });

  it('list ?limit must be a positive integer (400) and ?scope is validated (400)', async () => {
    expect(
      (await server().request('/v1/evidence/bundles?limit=0', { headers: opAuth })).status,
    ).toBe(400);
    expect(
      (await server().request('/v1/evidence/bundles?limit=abc', { headers: opAuth })).status,
    ).toBe(400);
    expect(
      (await server().request('/v1/evidence/bundles?scope=bogus', { headers: opAuth })).status,
    ).toBe(400);
  });

  it('list passes a huge ?limit to the facade where the store clamps it (no unbounded scan)', async () => {
    let seenLimit: number | undefined;
    const res = await server({
      evidenceList: async (f) => {
        seenLimit = f?.limit;
        return [manifest] as never;
      },
    }).request('/v1/evidence/bundles?limit=999999', { headers: opAuth });
    expect(res.status).toBe(200);
    // The route forwards the (validated positive) limit; the store/facade clamps to MAX_LIMIT.
    expect(seenLimit).toBe(999999);
  });

  it('the get route fetches under operator/fleet scope (null) — no client-supplied tenant id (BOLA)', async () => {
    let seenScope: string | null | undefined;
    await server({
      evidenceGet: async (_id: string, scope: string | null) => {
        seenScope = scope;
        return signed as never;
      },
    }).request('/v1/evidence/bundles/bid-abc', { headers: opAuth });
    expect(seenScope).toBeNull();
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

describe('HTTP request metrics middleware (per-request RED)', () => {
  interface Observed {
    method: string;
    route: string;
    statusClass: string;
    durationMs: number;
  }
  const collector = () => {
    const calls: Observed[] = [];
    return { calls, observeHttpRequest: (r: Observed) => calls.push(r) };
  };

  it('records status class + route template + duration for a normal request (using injected now)', async () => {
    const httpMetrics = collector();
    // Advance the injected clock between the start and end of the request to assert duration is
    // computed from the injected now() (not Date.now()): first call → 0 (start), next → 12 (end).
    let first = true;
    const advancingNow = (): number => {
      if (first) {
        first = false;
        return 0;
      }
      return 12;
    };
    const server = createHttpServer(fakeTf({ listTenants: async () => [] }), {
      token: 'tok',
      now: advancingNow,
      httpMetrics,
    });
    const res = await server.request('/v1/tenants', { headers: { authorization: 'Bearer tok' } });
    expect(res.status).toBe(200);
    expect(httpMetrics.calls).toHaveLength(1);
    expect(httpMetrics.calls[0]).toMatchObject({
      method: 'GET',
      route: '/v1/tenants',
      statusClass: '2xx',
      durationMs: 12,
    });
  });

  it('labels by the ROUTE TEMPLATE, never the raw id-bearing path (cardinality bound)', async () => {
    const httpMetrics = collector();
    const server = createHttpServer(fakeTf({ getTenant: async () => tenant }), {
      token: 'tok',
      httpMetrics,
    });
    await server.request('/v1/tenants/t1', { headers: { authorization: 'Bearer tok' } });
    expect(httpMetrics.calls[0]?.route).toBe('/v1/tenants/:id');
    // The concrete id never appears as a label.
    expect(httpMetrics.calls[0]?.route).not.toContain('t1');
  });

  it('records a 5xx for a handler that throws (still runs via try/finally)', async () => {
    const httpMetrics = collector();
    const server = createHttpServer(
      fakeTf({
        listTenants: async () => {
          throw new Error('boom upstream');
        },
      }),
      { token: 'tok', httpMetrics },
    );
    const res = await server.request('/v1/tenants', { headers: { authorization: 'Bearer tok' } });
    expect(res.status).toBe(500);
    expect(httpMetrics.calls).toHaveLength(1);
    expect(httpMetrics.calls[0]).toMatchObject({
      method: 'GET',
      route: '/v1/tenants',
      statusClass: '5xx',
    });
  });

  it('records a 4xx for an unauthenticated /v1 request (times before auth)', async () => {
    const httpMetrics = collector();
    const server = createHttpServer(fakeTf({ listTenants: async () => [] }), {
      token: 'tok',
      httpMetrics,
    });
    const res = await server.request('/v1/tenants'); // no bearer → 401
    expect(res.status).toBe(401);
    expect(httpMetrics.calls[0]?.statusClass).toBe('4xx');
  });

  it('times the unauthenticated /health probe too', async () => {
    const httpMetrics = collector();
    const server = createHttpServer(fakeTf({}), { token: 'tok', httpMetrics });
    await server.request('/health');
    expect(httpMetrics.calls.some((c) => c.route === '/health' && c.statusClass === '2xx')).toBe(
      true,
    );
  });

  it('uses a stable "(unmatched)" route label for an unknown path (no raw URL)', async () => {
    const httpMetrics = collector();
    const server = createHttpServer(fakeTf({}), { token: 'tok', httpMetrics });
    const res = await server.request('/no/such/route');
    expect(res.status).toBe(404);
    expect(httpMetrics.calls[0]?.route).toBe('(unmatched)');
  });

  it('does not record anything when no httpMetrics observer is wired', async () => {
    // Just assert the server works without the option (no throw, normal response).
    const server = createHttpServer(fakeTf({ listTenants: async () => [] }), { token: 'tok' });
    const res = await server.request('/v1/tenants', { headers: { authorization: 'Bearer tok' } });
    expect(res.status).toBe(200);
  });
});
