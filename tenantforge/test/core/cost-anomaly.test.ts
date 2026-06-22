import { describe, expect, it } from 'vitest';
import { detectCostAnomalies } from '../../src/core/cost-anomaly.js';
import type { TenantCost } from '../../src/core/cost.js';

const row = (over: Partial<TenantCost>): TenantCost => ({
  tenantId: 't',
  costUsd: 10,
  priceUsd: 20,
  marginUsd: 10,
  unprofitable: false,
  ...over,
});

describe('detectCostAnomalies', () => {
  it('flags unprofitable and unpriced by default; ignores healthy rows', () => {
    const found = detectCostAnomalies([
      row({ tenantId: 'healthy', costUsd: 5, priceUsd: 20, marginUsd: 15 }),
      row({ tenantId: 'loss', costUsd: 30, priceUsd: 20, marginUsd: -10 }),
      row({ tenantId: 'free-rider', costUsd: 8, priceUsd: null, marginUsd: null }),
    ]);
    expect(found.map((f) => [f.kind, f.tenantId])).toEqual([
      ['unprofitable', 'loss'],
      ['unpriced', 'free-rider'],
    ]);
  });

  it('treats a break-even tenant (margin exactly 0) as healthy, not unprofitable', () => {
    // Boundary: only margin < 0 is unprofitable. cost == price → margin 0 → no finding.
    expect(detectCostAnomalies([row({ costUsd: 20, priceUsd: 20, marginUsd: 0 })])).toEqual([]);
  });

  it('does not flag an unpriced tenant with zero cost (nothing to bill)', () => {
    expect(
      detectCostAnomalies([row({ tenantId: 'idle', costUsd: 0, priceUsd: null, marginUsd: null })]),
    ).toEqual([]);
  });

  it('flags low-margin only when minMarginUsd is set (opt-in)', () => {
    const rows = [row({ tenantId: 'thin', costUsd: 19, priceUsd: 20, marginUsd: 1 })];
    expect(detectCostAnomalies(rows)).toEqual([]); // disabled by default
    const found = detectCostAnomalies(rows, { minMarginUsd: 5 });
    expect(found.map((f) => f.kind)).toEqual(['low-margin']);
  });

  it('flags high-cost only when maxCostUsd is set, and not when already worse', () => {
    const rows = [
      row({ tenantId: 'big-ok', costUsd: 200, priceUsd: 500, marginUsd: 300 }),
      row({ tenantId: 'big-loss', costUsd: 300, priceUsd: 100, marginUsd: -200 }),
    ];
    expect(detectCostAnomalies(rows)).toEqual([
      expect.objectContaining({ kind: 'unprofitable', tenantId: 'big-loss' }),
    ]); // big-ok healthy until threshold set
    const found = detectCostAnomalies(rows, { maxCostUsd: 100 });
    // big-loss stays unprofitable (more severe); big-ok becomes high-cost.
    expect(found.map((f) => [f.kind, f.tenantId])).toEqual([
      ['unprofitable', 'big-loss'],
      ['high-cost', 'big-ok'],
    ]);
  });

  it('orders by severity, then descending cost, then tenant id', () => {
    const found = detectCostAnomalies([
      row({ tenantId: 'b', costUsd: 5, priceUsd: 1, marginUsd: -4 }),
      row({ tenantId: 'a', costUsd: 50, priceUsd: 1, marginUsd: -49 }),
      row({ tenantId: 'c', costUsd: 9, priceUsd: null, marginUsd: null }),
    ]);
    expect(found.map((f) => f.tenantId)).toEqual(['a', 'b', 'c']); // two unprofitable (cost desc), then unpriced
  });

  it('breaks ties on tenant id when severity and cost are equal', () => {
    const found = detectCostAnomalies([
      row({ tenantId: 'zeta', costUsd: 7, priceUsd: 1, marginUsd: -6 }),
      row({ tenantId: 'alpha', costUsd: 7, priceUsd: 1, marginUsd: -6 }),
    ]);
    expect(found.map((f) => f.tenantId)).toEqual(['alpha', 'zeta']);
  });
});
