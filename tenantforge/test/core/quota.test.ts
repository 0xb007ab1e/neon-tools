import { describe, expect, it } from 'vitest';
import { evaluateQuota, type Quota } from '../../src/core/quota.js';
import type { Consumption } from '../../src/core/usage.js';

const consumption = (over: Partial<Consumption> = {}): Consumption => ({
  computeTimeSeconds: 0,
  activeTimeSeconds: 0,
  writtenDataBytes: 0,
  syntheticStorageBytes: 0,
  ...over,
});

describe('evaluateQuota', () => {
  it('an empty quota never breaches (no enforcement)', () => {
    const status = evaluateQuota(consumption({ syntheticStorageBytes: 1e12 }), {});
    expect(status).toEqual({ exceeded: false, breaches: [] });
  });

  it('reports a breach when a metric strictly exceeds its limit', () => {
    const quota: Quota = { maxStorageBytes: 100 };
    expect(evaluateQuota(consumption({ syntheticStorageBytes: 101 }), quota).exceeded).toBe(true);
    expect(evaluateQuota(consumption({ syntheticStorageBytes: 100 }), quota).exceeded).toBe(false); // at limit = ok
    expect(evaluateQuota(consumption({ syntheticStorageBytes: 99 }), quota).exceeded).toBe(false);
  });

  it('collects every exceeded limit with metric/limit/actual', () => {
    const quota: Quota = {
      maxComputeTimeSeconds: 10,
      maxActiveTimeSeconds: 10,
      maxWrittenDataBytes: 10,
      maxStorageBytes: 10,
    };
    const status = evaluateQuota(
      consumption({
        computeTimeSeconds: 20,
        activeTimeSeconds: 5,
        writtenDataBytes: 30,
        syntheticStorageBytes: 11,
      }),
      quota,
    );
    expect(status.exceeded).toBe(true);
    expect(status.breaches.map((b) => b.metric).sort()).toEqual([
      'computeTimeSeconds',
      'syntheticStorageBytes',
      'writtenDataBytes',
    ]);
    const compute = status.breaches.find((b) => b.metric === 'computeTimeSeconds');
    expect(compute).toEqual({ metric: 'computeTimeSeconds', limit: 10, actual: 20 });
  });
});
