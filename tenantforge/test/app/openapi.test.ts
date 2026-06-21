import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import type { TenantRecord } from '../../src/core/domain.js';
import type { TenantForge } from '../../src/app/lib.js';
import { createHttpServer } from '../../src/app/http-server.js';

const TOKEN = 'test-token';

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

/** Permissive TenantForge so every documented route resolves (we assert routing, not behavior). */
const permissiveTf = (): TenantForge =>
  ({
    health: () => Promise.resolve({ status: 'ok', checks: { registry: 'ok' } }),
    provision: () => Promise.resolve({ tenant, connectionUri: 'x' }),
    listTenants: () => Promise.resolve([tenant]),
    getTenant: () => Promise.resolve(tenant),
    suspend: () => Promise.resolve(tenant),
    resume: () => Promise.resolve(tenant),
    offboard: () => Promise.resolve({ tenant, archive: null }),
    purge: () => Promise.resolve(tenant),
    ingestPaymentWebhook: () =>
      Promise.resolve({
        id: 'evt',
        type: 'charge.succeeded',
        provider: 'stripe',
        rawType: 'x',
        occurredAt: 'x',
      }),
    chargeHistory: () => Promise.resolve([]),
    paymentWebhookHistory: () => Promise.resolve([]),
    dunningHistory: () => Promise.resolve([]),
    billingRunHistory: () => Promise.resolve([]),
    refundHistory: () => Promise.resolve([]),
    notificationHistory: () => Promise.resolve([]),
    planChangeHistory: () => Promise.resolve([]),
    creditBalance: () => Promise.resolve(0),
    creditHistory: () => Promise.resolve([]),
    usageAlertHistory: () => Promise.resolve([]),
    invoiceDeliveryHistory: () => Promise.resolve([]),
    queryAudit: () => Promise.resolve([]),
    listPlans: () => [],
    previewPlanChange: (id: string, newPriceUsd: number) =>
      Promise.resolve({
        tenantId: id,
        oldPriceUsd: 0,
        newPriceUsd,
        period: { from: 'x', to: 'y' },
        proratedDeltaMinor: 0,
      }),
  }) as unknown as TenantForge;

interface OpenApiDoc {
  paths: Record<string, Record<string, { security?: unknown[] }>>;
}

const spec = parse(
  readFileSync(fileURLToPath(new URL('../../openapi.yaml', import.meta.url)), 'utf8'),
) as OpenApiDoc;

// A body that satisfies every documented POST (zod strips the unused fields per route).
const postBody = JSON.stringify({ slug: 'acme', confirm: true, skipExport: true, reason: 'x' });
const operations = Object.entries(spec.paths).flatMap(([path, methods]) =>
  Object.keys(methods).map((method) => ({ path, method, op: methods[method]! })),
);

describe('OpenAPI contract ↔ HTTP app', () => {
  it('documents the operations the app serves', () => {
    expect(operations.length).toBeGreaterThanOrEqual(7);
  });

  it.each(operations)('serves $method $path (documented → routed)', async ({ path, method }) => {
    const url = `http://local${path.replace('{id}', 't1')}`;
    const res = await createHttpServer(permissiveTf(), {
      token: TOKEN,
      paymentWebhooks: true,
    }).request(url, {
      method: method.toUpperCase(),
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      ...(method === 'post' ? { body: postBody } : {}),
    });
    // The route exists (not a 404/405 from the router).
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(405);
  });

  it.each(operations.filter((o) => o.path.startsWith('/v1')))(
    'requires auth for $method $path',
    async ({ path, method }) => {
      const url = `http://local${path.replace('{id}', 't1')}`;
      const res = await createHttpServer(permissiveTf(), { token: TOKEN }).request(url, {
        method: method.toUpperCase(),
        ...(method === 'post'
          ? { headers: { 'content-type': 'application/json' }, body: postBody }
          : {}),
      });
      expect(res.status).toBe(401);
    },
  );

  it('marks /health as public (security: [])', () => {
    expect(spec.paths['/health']?.get?.security).toEqual([]);
  });
});
