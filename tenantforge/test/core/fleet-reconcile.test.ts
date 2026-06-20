import { describe, expect, it } from 'vitest';
import { planFleetReconcile } from '../../src/core/fleet-reconcile.js';
import type { TenantMigrationProgress } from '../../src/core/fleet-drift.js';

const versions = ['0001', '0002', '0003'];
const t = (
  tenantId: string,
  applied: string[],
  failed: string[] = [],
): TenantMigrationProgress => ({
  tenantId,
  applied,
  failed,
});

describe('planFleetReconcile', () => {
  it('computes per-tenant ordered missing versions up to latest, and the up-to-date set', () => {
    const plan = planFleetReconcile({
      versions,
      tenants: [t('behind', ['0001']), t('current', versions), t('fresh', [])],
      batchSize: 10,
    });
    expect(plan.target).toBe('0003');
    expect(plan.perTenant).toEqual([
      { tenantId: 'behind', missing: ['0002', '0003'] },
      { tenantId: 'fresh', missing: ['0001', '0002', '0003'] },
    ]);
    expect(plan.pendingTenants).toEqual(['behind', 'fresh']);
    expect(plan.upToDate).toEqual(['current']);
    expect(plan.totalMissing).toBe(5);
  });

  it('re-attempts a previously-failed version (it reappears as missing)', () => {
    const plan = planFleetReconcile({
      versions,
      tenants: [t('x', ['0001'], ['0002'])],
      batchSize: 10,
    });
    expect(plan.perTenant[0]?.missing).toEqual(['0002', '0003']);
  });

  it('reconciles only up to an explicit target', () => {
    const plan = planFleetReconcile({
      versions,
      tenants: [t('x', [])],
      target: '0002',
      batchSize: 10,
    });
    expect(plan.target).toBe('0002');
    expect(plan.perTenant[0]?.missing).toEqual(['0001', '0002']); // 0003 is out of scope
  });

  it('batches the pending tenants', () => {
    const plan = planFleetReconcile({
      versions,
      tenants: [t('a', []), t('b', []), t('c', [])],
      batchSize: 2,
    });
    expect(plan.batches).toEqual([['a', 'b'], ['c']]);
  });

  it('handles an empty catalog (everyone trivially up to date)', () => {
    const plan = planFleetReconcile({ versions: [], tenants: [t('a', [])], batchSize: 10 });
    expect(plan.target).toBeNull();
    expect(plan.perTenant).toEqual([]);
    expect(plan.upToDate).toEqual(['a']);
    expect(plan.totalMissing).toBe(0);
    expect(plan.batches).toEqual([]);
  });

  it('rejects a non-positive batch size', () => {
    expect(() => planFleetReconcile({ versions, tenants: [], batchSize: 0 })).toThrow(/batchSize/);
  });

  it('rejects a target that is not in the catalog', () => {
    expect(() =>
      planFleetReconcile({ versions, tenants: [], target: '9999', batchSize: 10 }),
    ).toThrow(/not in the migration catalog/);
  });
});
