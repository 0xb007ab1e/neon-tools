import { describe, expect, it } from 'vitest';
import { evaluateUsageAlerts, normalizeThresholds } from '../../src/core/usage-alert.js';
import type { Consumption } from '../../src/core/usage.js';

const consumption: Consumption = {
  computeTimeSeconds: 90, // 90% of a 100 allowance
  activeTimeSeconds: 50,
  syntheticStorageBytes: 1_200, // 120% of a 1_000 allowance → overage
  writtenDataBytes: 10,
};

describe('normalizeThresholds', () => {
  it('keeps positive finite values, de-duplicates, and sorts ascending', () => {
    expect(normalizeThresholds([1.0, 0.8, 0.8, -1, 0, Number.NaN, Infinity, 0.5])).toEqual([
      0.5, 0.8, 1.0,
    ]);
  });

  it('returns empty for no valid thresholds', () => {
    expect(normalizeThresholds([0, -2, Number.NaN])).toEqual([]);
  });
});

describe('evaluateUsageAlerts', () => {
  it('alerts per dimension at the highest crossed threshold, reporting fraction + overage', () => {
    const alerts = evaluateUsageAlerts(
      consumption,
      { computeTimeSeconds: 100, syntheticStorageBytes: 1_000 },
      [0.8, 1.0],
    );
    expect(alerts).toEqual([
      {
        metric: 'computeTimeSeconds',
        used: 90,
        included: 100,
        usedFraction: 0.9,
        thresholdCrossed: 0.8, // 0.9 crosses 0.8 but not 1.0
        overageUnits: 0,
      },
      {
        metric: 'syntheticStorageBytes',
        used: 1_200,
        included: 1_000,
        usedFraction: 1.2,
        thresholdCrossed: 1.0, // already over the allowance
        overageUnits: 200,
      },
    ]);
  });

  it('emits nothing for a dimension below the lowest threshold', () => {
    const alerts = evaluateUsageAlerts(consumption, { computeTimeSeconds: 1_000 }, [0.8, 1.0]);
    expect(alerts).toEqual([]); // 90/1000 = 0.09 < 0.8
  });

  it('ignores dimensions with no allowance (zero or unset)', () => {
    const alerts = evaluateUsageAlerts(
      consumption,
      { computeTimeSeconds: 0, activeTimeSeconds: 10 },
      [0.8],
    );
    // compute allowance 0 ⇒ skipped; active 50/10 = 5.0 ≥ 0.8 ⇒ alert.
    expect(alerts.map((a) => a.metric)).toEqual(['activeTimeSeconds']);
  });

  it('returns empty when no thresholds are configured', () => {
    expect(evaluateUsageAlerts(consumption, { computeTimeSeconds: 100 }, [])).toEqual([]);
  });

  it('treats exactly-at-threshold as crossed', () => {
    const alerts = evaluateUsageAlerts(
      { ...consumption, computeTimeSeconds: 80 },
      { computeTimeSeconds: 100 },
      [0.8],
    );
    expect(alerts[0]?.thresholdCrossed).toBe(0.8);
    expect(alerts[0]?.usedFraction).toBe(0.8);
  });
});
