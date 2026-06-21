import { describe, expect, it, vi } from 'vitest';
import type { TenantRecord } from '../../src/core/domain.js';
import type { TenantEvent } from '../../src/core/observability.js';
import type { TenantRegistry } from '../../src/ports/tenant-registry.js';
import type { UsageProvider } from '../../src/ports/usage-provider.js';
import { createUsageAlertEngine } from '../../src/adapters/usage-alert-engine.js';

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

/** Usage provider returning fixed compute consumption; throws for projects in `failFor`. */
function fakeUsage(computeSeconds: number, failFor: string[] = []): UsageProvider {
  return {
    getProjectConsumption: (projectId: string) => {
      if (failFor.includes(projectId)) return Promise.reject(new Error('usage fetch failed'));
      return Promise.resolve([
        {
          computeTimeSeconds: computeSeconds,
          activeTimeSeconds: 0,
          syntheticStorageBytes: 0,
          writtenDataBytes: 0,
        },
      ]);
    },
  };
}

describe('createUsageAlertEngine.check', () => {
  it('alerts when consumption crosses a threshold of the plan allowance and emits an event', () => {
    const emit = vi.fn<(e: TenantEvent) => void>();
    const engine = createUsageAlertEngine({
      registry: fakeRegistry([
        tenant({ id: 't1', metadata: { includedUsage: { computeTimeSeconds: 100 } } }),
      ]),
      usageProvider: fakeUsage(90), // 90% of 100
      thresholds: [0.8, 1.0],
      emit,
      now,
    });
    return engine.check('t1', period).then((result) => {
      expect(result.alerts).toHaveLength(1);
      expect(result.alerts[0]?.thresholdCrossed).toBe(0.8);
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit.mock.calls[0]?.[0]?.event).toBe('tenant.usage_alert');
    });
  });

  it('returns no alerts (and emits nothing) when the tenant has no allowances', () => {
    const emit = vi.fn<(e: TenantEvent) => void>();
    const engine = createUsageAlertEngine({
      registry: fakeRegistry([tenant({ id: 't1', metadata: {} })]),
      usageProvider: fakeUsage(1_000_000),
      thresholds: [0.8],
      emit,
      now,
    });
    return engine.check('t1', period).then((result) => {
      expect(result.alerts).toEqual([]);
      expect(emit).not.toHaveBeenCalled();
    });
  });

  it('throws for an unknown / non-active / unprovisioned tenant', async () => {
    const engine = createUsageAlertEngine({
      registry: fakeRegistry([
        tenant({ id: 'sus', status: 'suspended' }),
        tenant({ id: 'np', neonProjectId: null }),
      ]),
      usageProvider: fakeUsage(0),
      thresholds: [0.8],
      now,
    });
    await expect(engine.check('ghost', period)).rejects.toThrow(/not found/);
    await expect(engine.check('sus', period)).rejects.toThrow(/must be active and provisioned/);
    await expect(engine.check('np', period)).rejects.toThrow(/must be active and provisioned/);
  });
});

describe('createUsageAlertEngine.checkAll', () => {
  it('sweeps active tenants, lists only those alerting (sorted), and isolates failures', async () => {
    const emit = vi.fn<(e: TenantEvent) => void>();
    const engine = createUsageAlertEngine({
      registry: fakeRegistry([
        tenant({ id: 'b', metadata: { includedUsage: { computeTimeSeconds: 100 } } }), // 90% → alert
        tenant({ id: 'a', metadata: { includedUsage: { computeTimeSeconds: 1000 } } }), // 9% → none
        tenant({
          id: 'd',
          neonProjectId: 'proj-d',
          metadata: { includedUsage: { computeTimeSeconds: 100 } },
        }),
      ]),
      usageProvider: fakeUsage(90, ['proj-d']),
      thresholds: [0.8],
      emit,
      now,
    });
    const report = await engine.checkAll(period);
    expect(report.scanned).toBe(3);
    expect(report.alerted.map((a) => a.tenantId)).toEqual(['b']);
    expect(report.failed.map((f) => f.tenantId)).toEqual(['d']);
    // per-alert event for 'b' + the sweep summary.
    expect(emit.mock.calls.map((c) => c[0].event)).toContain('tenant.usage_alert_sweep');
  });
});
