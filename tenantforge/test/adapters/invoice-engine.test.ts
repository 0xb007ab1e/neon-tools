import { describe, expect, it } from 'vitest';
import type { TenantRecord } from '../../src/core/domain.js';
import type { TenantRegistry } from '../../src/ports/tenant-registry.js';
import type { UsageProvider } from '../../src/ports/usage-provider.js';
import { createInvoiceEngine } from '../../src/adapters/invoice-engine.js';

const period = {
  from: new Date('2026-06-01T00:00:00.000Z'),
  to: new Date('2026-07-01T00:00:00.000Z'),
};
const now = (): Date => new Date('2026-07-01T00:00:00.000Z');

const tenant = (over: Partial<TenantRecord>): TenantRecord => ({
  id: 't',
  slug: 's',
  region: 'aws-us-east-1',
  status: 'active',
  neonProjectId: 'proj',
  metadata: {},
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});

function fakeRegistry(tenants: TenantRecord[]): TenantRegistry {
  return {
    list: () => Promise.resolve(tenants),
    getById: (id: string) => Promise.resolve(tenants.find((t) => t.id === id) ?? null),
  } as unknown as TenantRegistry;
}

/** Usage provider that returns fixed consumption, or throws for projects in `failFor`. */
function fakeUsage(failFor: string[] = []): UsageProvider {
  return {
    getProjectConsumption: (projectId: string) => {
      if (failFor.includes(projectId)) return Promise.reject(new Error('usage fetch failed'));
      return Promise.resolve([
        {
          computeTimeSeconds: 100,
          activeTimeSeconds: 0,
          syntheticStorageBytes: 0,
          writtenDataBytes: 0,
        },
      ]);
    },
  };
}

const rates = { computeSecondUsd: 0.01 };

describe('createInvoiceEngine.invoice', () => {
  it('meters a tenant and bills usage + its plan fee from metadata.priceUsd', async () => {
    const engine = createInvoiceEngine({
      registry: fakeRegistry([tenant({ id: 't1', metadata: { priceUsd: 9 } })]),
      usageProvider: fakeUsage(),
      rates,
      now,
    });
    const inv = await engine.invoice('t1', period);
    // base 9 + compute 100*0.01 = 1 → 10
    expect(inv.totalUsd).toBe(10);
    expect(inv.lineItems[0]?.description).toBe('Base plan fee');
  });

  it('throws for an unknown tenant and for one without a provisioned project', async () => {
    const engine = createInvoiceEngine({
      registry: fakeRegistry([tenant({ id: 't1', neonProjectId: null })]),
      usageProvider: fakeUsage(),
      rates,
      now,
    });
    await expect(engine.invoice('ghost', period)).rejects.toThrow(/not found/);
    await expect(engine.invoice('t1', period)).rejects.toThrow(/no provisioned project/);
  });
});

describe('createInvoiceEngine.invoiceFleet', () => {
  it('invoices active tenants, sorts by id, and isolates unmeterable ones', async () => {
    const engine = createInvoiceEngine({
      registry: fakeRegistry([
        tenant({ id: 'b', neonProjectId: 'proj-b' }),
        tenant({ id: 'a', neonProjectId: 'proj-a' }),
        tenant({ id: 'c', neonProjectId: null }), // no project → unmetered
        tenant({ id: 'd', neonProjectId: 'proj-d' }), // usage fetch fails → unmetered
      ]),
      usageProvider: fakeUsage(['proj-d']),
      rates,
      now,
    });
    const report = await engine.invoiceFleet(period);
    expect(report.invoices.map((i) => i.tenantId)).toEqual(['a', 'b']); // sorted; c/d excluded
    expect(report.unmetered).toEqual(['c', 'd']);
  });
});
