import { describe, expect, it } from 'vitest';
import { createCostEngine } from '../../src/adapters/cost-engine.js';
import type { TenantRecord } from '../../src/core/domain.js';
import type { Consumption } from '../../src/core/usage.js';
import type { UsageProvider } from '../../src/ports/usage-provider.js';
import type { TenantRegistry } from '../../src/ports/tenant-registry.js';

const tenant = (over: Partial<TenantRecord> = {}): TenantRecord => ({
  id: 't1',
  slug: 'acme',
  region: 'aws-us-east-1',
  status: 'active',
  neonProjectId: 'proj-1',
  metadata: {},
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});

const fakeRegistry = (tenants: TenantRecord[]): TenantRegistry =>
  ({ list: async () => tenants.filter((t) => t.status === 'active') }) as unknown as TenantRegistry;

const bucket = (over: Partial<Consumption>): Consumption => ({
  computeTimeSeconds: 0,
  activeTimeSeconds: 0,
  writtenDataBytes: 0,
  syntheticStorageBytes: 0,
  ...over,
});

const period = { from: new Date(0), to: new Date(1000) };
const rates = { computeSecondUsd: 0.01 };

describe('cost engine', () => {
  it('reports per-tenant cost and margin from metadata price', async () => {
    const usage: UsageProvider = {
      getProjectConsumption: async (id) =>
        id === 'proj-a'
          ? [bucket({ computeTimeSeconds: 1000 })]
          : [bucket({ computeTimeSeconds: 100 })],
    };
    const engine = createCostEngine({
      registry: fakeRegistry([
        tenant({ id: 'a', neonProjectId: 'proj-a', metadata: { priceUsd: 5 } }), // cost 10 → margin -5
        tenant({ id: 'b', neonProjectId: 'proj-b' }), // cost 1, unpriced
      ]),
      usageProvider: usage,
      rates,
      now: () => new Date('2026-06-20T00:00:00.000Z'),
    });
    const r = await engine.report(period);
    expect(r.totals).toEqual({
      tenants: 2,
      costUsd: 11,
      priceUsd: 5,
      marginUsd: -5,
      unprofitable: 1,
      unpriced: 1,
    });
  });

  it('lists unprovisioned / fetch-failing tenants as unmetered (failure-isolated)', async () => {
    const usage: UsageProvider = {
      getProjectConsumption: async (id) => {
        if (id === 'proj-x') throw new Error('neon down');
        return [bucket({ computeTimeSeconds: 10 })];
      },
    };
    const engine = createCostEngine({
      registry: fakeRegistry([
        tenant({ id: 'ok', neonProjectId: 'proj-ok' }),
        tenant({ id: 'x', neonProjectId: 'proj-x' }), // fetch throws
        tenant({ id: 'np', neonProjectId: null }), // never provisioned
      ]),
      usageProvider: usage,
      rates,
    });
    const r = await engine.report(period);
    expect(r.rows.map((x) => x.tenantId)).toEqual(['ok']);
    expect(r.unmetered.sort()).toEqual(['np', 'x']);
  });
});
