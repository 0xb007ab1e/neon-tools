import { describe, expect, it } from 'vitest';
import type { Consumption } from '../../src/core/usage.js';
import { aggregateConsumption, assertPeriod } from '../../src/core/usage.js';

describe('assertPeriod', () => {
  it('accepts a valid forward range', () => {
    expect(() =>
      assertPeriod({ from: new Date('2026-05-01'), to: new Date('2026-06-01') }),
    ).not.toThrow();
  });

  it('rejects an inverted range', () => {
    expect(() =>
      assertPeriod({ from: new Date('2026-06-01'), to: new Date('2026-05-01') }),
    ).toThrow(/must not be after/);
  });

  it('rejects an invalid date', () => {
    expect(() => assertPeriod({ from: new Date('nope'), to: new Date('2026-06-01') })).toThrow(
      /valid dates/,
    );
  });
});

describe('aggregateConsumption', () => {
  const bucket = (over: Partial<Consumption>): Consumption => ({
    computeTimeSeconds: 0,
    activeTimeSeconds: 0,
    writtenDataBytes: 0,
    syntheticStorageBytes: 0,
    ...over,
  });

  it('sums cumulative metrics and takes peak storage', () => {
    expect(
      aggregateConsumption([
        bucket({ computeTimeSeconds: 10, writtenDataBytes: 100, syntheticStorageBytes: 500 }),
        bucket({ computeTimeSeconds: 5, writtenDataBytes: 50, syntheticStorageBytes: 700 }),
      ]),
    ).toEqual({
      computeTimeSeconds: 15,
      activeTimeSeconds: 0,
      writtenDataBytes: 150,
      syntheticStorageBytes: 700, // peak, not 1200
    });
  });

  it('returns zeros for an empty period', () => {
    expect(aggregateConsumption([])).toEqual({
      computeTimeSeconds: 0,
      activeTimeSeconds: 0,
      writtenDataBytes: 0,
      syntheticStorageBytes: 0,
    });
  });
});
