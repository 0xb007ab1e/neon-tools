import { describe, expect, it } from 'vitest';
import { buildCostReport, estimateCostUsd, type CostRates } from '../../src/core/cost.js';
import type { Consumption } from '../../src/core/usage.js';

const consumption = (over: Partial<Consumption> = {}): Consumption => ({
  computeTimeSeconds: 0,
  activeTimeSeconds: 0,
  writtenDataBytes: 0,
  syntheticStorageBytes: 0,
  ...over,
});
const rates: CostRates = { computeSecondUsd: 0.01, storageByteUsd: 0.000001 };
const now = new Date('2026-06-20T00:00:00.000Z');

describe('estimateCostUsd', () => {
  it('sums set rates and ignores unset ones', () => {
    // 100 compute-s * 0.01 + 2_000_000 bytes * 0.000001 = 1.00 + 2.00 = 3.00
    expect(
      estimateCostUsd(
        consumption({ computeTimeSeconds: 100, syntheticStorageBytes: 2_000_000 }),
        rates,
      ),
    ).toBeCloseTo(3);
  });
  it('is zero under empty rates', () => {
    expect(estimateCostUsd(consumption({ computeTimeSeconds: 999 }), {})).toBe(0);
  });
});

describe('buildCostReport', () => {
  it('computes per-tenant cost, margin, and unprofitability; rows sorted', () => {
    const r = buildCostReport(
      [
        { tenantId: 'b', consumption: consumption({ computeTimeSeconds: 100 }), priceUsd: 5 }, // cost 1, margin 4
        { tenantId: 'a', consumption: consumption({ computeTimeSeconds: 1000 }), priceUsd: 5 }, // cost 10, margin -5, unprofitable
        { tenantId: 'c', consumption: consumption({ computeTimeSeconds: 50 }) }, // no price
      ],
      { rates, now },
    );
    expect(r.rows.map((x) => x.tenantId)).toEqual(['a', 'b', 'c']); // sorted
    const a = r.rows[0]!;
    expect(a).toEqual({
      tenantId: 'a',
      costUsd: 10,
      priceUsd: 5,
      marginUsd: -5,
      unprofitable: true,
    });
    const c = r.rows[2]!;
    expect(c.priceUsd).toBeNull();
    expect(c.marginUsd).toBeNull();
    expect(c.unprofitable).toBe(false);
  });

  it('totals count price/margin only for priced tenants; flags unpriced + unprofitable', () => {
    const r = buildCostReport(
      [
        { tenantId: 'a', consumption: consumption({ computeTimeSeconds: 1000 }), priceUsd: 5 }, // cost 10
        { tenantId: 'b', consumption: consumption({ computeTimeSeconds: 100 }) }, // cost 1, unpriced
      ],
      { rates, now, unmetered: ['z'] },
    );
    expect(r.totals).toEqual({
      tenants: 2,
      costUsd: 11,
      priceUsd: 5,
      marginUsd: -5,
      unprofitable: 1,
      unpriced: 1,
    });
    expect(r.unmetered).toEqual(['z']);
    expect(r.generatedAt).toBe('2026-06-20T00:00:00.000Z');
  });

  it('handles an empty fleet', () => {
    const r = buildCostReport([], { rates, now });
    expect(r.rows).toEqual([]);
    expect(r.totals).toEqual({
      tenants: 0,
      costUsd: 0,
      priceUsd: 0,
      marginUsd: 0,
      unprofitable: 0,
      unpriced: 0,
    });
  });
});
