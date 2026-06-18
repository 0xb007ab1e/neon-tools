import { describe, expect, it } from 'vitest';
import { createQuotaEngine } from '../../src/adapters/quota-engine.js';
import type { TenantRecord } from '../../src/core/domain.js';
import type { TenantEvent } from '../../src/core/observability.js';
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
  ({
    getById: async (id: string) => tenants.find((t) => t.id === id) ?? null,
    list: async () => tenants.filter((t) => t.status === 'active'),
  }) as unknown as TenantRegistry;

const usageOf = (c: Partial<Consumption>): UsageProvider => ({
  getProjectConsumption: async () => [
    {
      computeTimeSeconds: 0,
      activeTimeSeconds: 0,
      writtenDataBytes: 0,
      syntheticStorageBytes: 0,
      ...c,
    },
  ],
});

const period = { from: new Date(0), to: new Date(1000) };

describe('quota engine', () => {
  it('reports a breach and emits a quota_exceeded event', async () => {
    const events: TenantEvent[] = [];
    const engine = createQuotaEngine({
      registry: fakeRegistry([tenant()]),
      usageProvider: usageOf({ syntheticStorageBytes: 200 }),
      emit: (e) => events.push(e),
    });
    const { status } = await engine.check('t1', period, { maxStorageBytes: 100 });
    expect(status.exceeded).toBe(true);
    expect(events.map((e) => e.event)).toContain('tenant.quota_exceeded');
  });

  it('passes within quota and emits quota_checked', async () => {
    const events: TenantEvent[] = [];
    const engine = createQuotaEngine({
      registry: fakeRegistry([tenant()]),
      usageProvider: usageOf({ syntheticStorageBytes: 50 }),
      emit: (e) => events.push(e),
    });
    const { status } = await engine.check('t1', period, { maxStorageBytes: 100 });
    expect(status.exceeded).toBe(false);
    expect(events.map((e) => e.event)).toContain('tenant.quota_checked');
  });

  it('fails closed for a non-active tenant', async () => {
    const engine = createQuotaEngine({
      registry: fakeRegistry([tenant({ status: 'suspended' })]),
      usageProvider: usageOf({}),
    });
    await expect(engine.check('t1', period, {})).rejects.toThrow(/must be active and provisioned/);
  });

  it('checkAll invokes onBreach only for over-quota tenants (enforcement) and is failure-isolated', async () => {
    const enforced: string[] = [];
    const engine = createQuotaEngine({
      registry: fakeRegistry([tenant({ id: 't1' }), tenant({ id: 't2' })]),
      // Both tenants report 200 bytes; with a 100-byte limit, both breach.
      usageProvider: usageOf({ syntheticStorageBytes: 200 }),
    });
    const report = await engine.checkAll(
      period,
      { maxStorageBytes: 100 },
      { onBreach: async (id) => void enforced.push(id) },
    );
    expect(report.scanned).toBe(2);
    expect(report.exceeded.sort()).toEqual(['t1', 't2']);
    expect(report.enforced.sort()).toEqual(['t1', 't2']);
    expect(enforced.sort()).toEqual(['t1', 't2']);
  });

  it('checkAll isolates a failing tenant and emits the sweep event', async () => {
    const events: TenantEvent[] = [];
    const engine = createQuotaEngine({
      registry: fakeRegistry([tenant({ id: 't1' }), tenant({ id: 't2', neonProjectId: null })]),
      usageProvider: usageOf({ syntheticStorageBytes: 5 }),
      emit: (e) => events.push(e),
    });
    const report = await engine.checkAll(period, { maxStorageBytes: 100 });
    expect(report.scanned).toBe(2);
    expect(report.failed.map((f) => f.tenantId)).toEqual(['t2']); // unprovisioned → check throws
    const sweep = events.find((e) => e.event === 'tenant.quota_sweep');
    expect(sweep?.outcome).toBe('error');
  });
});
