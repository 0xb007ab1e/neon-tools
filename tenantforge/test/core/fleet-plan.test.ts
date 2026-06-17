import { describe, expect, it } from 'vitest';
import type { TenantMigrationState } from '../../src/core/domain.js';
import { planFleetMigration } from '../../src/core/fleet-plan.js';

const M = 'mig-1';

describe('planFleetMigration', () => {
  it('classifies applied vs pending and batches the pending set', () => {
    const states: TenantMigrationState[] = [
      { tenantId: 't1', migrationId: M, status: 'applied' },
      { tenantId: 't2', migrationId: M, status: 'failed' }, // retryable → pending
      { tenantId: 't3', migrationId: M, status: 'pending' },
      // t4 has no state → pending
    ];
    const plan = planFleetMigration({
      migrationId: M,
      tenantIds: ['t1', 't2', 't3', 't4'],
      states,
      batchSize: 2,
    });
    expect(plan.applied).toEqual(['t1']);
    expect(plan.pending).toEqual(['t2', 't3', 't4']);
    expect(plan.batches).toEqual([['t2', 't3'], ['t4']]);
  });

  it('ignores states belonging to other migrations (resumability is per-migration)', () => {
    const states: TenantMigrationState[] = [
      { tenantId: 't1', migrationId: 'other', status: 'applied' },
    ];
    const plan = planFleetMigration({ migrationId: M, tenantIds: ['t1'], states, batchSize: 5 });
    expect(plan.applied).toEqual([]);
    expect(plan.pending).toEqual(['t1']);
  });

  it('produces no batches when nothing is pending', () => {
    const states: TenantMigrationState[] = [{ tenantId: 't1', migrationId: M, status: 'applied' }];
    const plan = planFleetMigration({ migrationId: M, tenantIds: ['t1'], states, batchSize: 3 });
    expect(plan.pending).toEqual([]);
    expect(plan.batches).toEqual([]);
  });

  it('rejects a non-positive or non-integer batch size', () => {
    const base = { migrationId: M, tenantIds: ['t1'], states: [] };
    expect(() => planFleetMigration({ ...base, batchSize: 0 })).toThrow(/positive integer/);
    expect(() => planFleetMigration({ ...base, batchSize: 1.5 })).toThrow(/positive integer/);
  });
});
