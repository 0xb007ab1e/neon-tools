import { describe, expect, it } from 'vitest';
import { assertPlanCatalog, findPlan, planAssignment } from '../../src/core/plan.js';
import type { PlanDefinition } from '../../src/core/plan.js';

const catalog: PlanDefinition[] = [
  { id: 'starter', name: 'Starter', priceUsd: 0, includedUsage: { computeTimeSeconds: 100 } },
  {
    id: 'pro',
    priceUsd: 49,
    includedUsage: { computeTimeSeconds: 10_000, syntheticStorageBytes: 5e9 },
  },
];

describe('assertPlanCatalog', () => {
  it('accepts a valid catalog and returns it', () => {
    expect(assertPlanCatalog(catalog)).toBe(catalog);
  });

  it('rejects an empty or missing id', () => {
    expect(() => assertPlanCatalog([{ id: '' }])).toThrow(/non-empty id/);
  });

  it('rejects duplicate ids', () => {
    expect(() => assertPlanCatalog([{ id: 'x' }, { id: 'x' }])).toThrow(/duplicate plan id x/);
  });

  it('rejects a negative price or allowance', () => {
    expect(() => assertPlanCatalog([{ id: 'p', priceUsd: -1 }])).toThrow(/priceUsd must be/);
    expect(() =>
      assertPlanCatalog([{ id: 'p', includedUsage: { computeTimeSeconds: -5 } }]),
    ).toThrow(/includedUsage.computeTimeSeconds must be/);
  });
});

describe('findPlan', () => {
  it('finds by id, or returns undefined', () => {
    expect(findPlan(catalog, 'pro')?.priceUsd).toBe(49);
    expect(findPlan(catalog, 'ghost')).toBeUndefined();
  });
});

describe('planAssignment', () => {
  it('derives the metadata patch (plan fully defines billing)', () => {
    expect(planAssignment(catalog[1]!)).toEqual({
      planId: 'pro',
      priceUsd: 49,
      includedUsage: { computeTimeSeconds: 10_000, syntheticStorageBytes: 5e9 },
    });
  });

  it('defaults price to 0 and allowances to empty (clearing prior overrides)', () => {
    expect(planAssignment({ id: 'free' })).toEqual({
      planId: 'free',
      priceUsd: 0,
      includedUsage: {},
    });
  });
});
