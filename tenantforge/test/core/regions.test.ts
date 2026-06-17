import { describe, expect, it } from 'vitest';
import { assertRegion, isValidRegion, KNOWN_REGIONS } from '../../src/core/regions.js';

describe('isValidRegion', () => {
  it('accepts known regions', () => {
    expect(isValidRegion('aws-us-east-1')).toBe(true);
    expect(isValidRegion(KNOWN_REGIONS[0]!)).toBe(true);
  });

  it('rejects unknown regions', () => {
    expect(isValidRegion('mars-north-1')).toBe(false);
    expect(isValidRegion('')).toBe(false);
  });
});

describe('assertRegion', () => {
  it('returns the region when valid', () => {
    expect(assertRegion('aws-eu-central-1')).toBe('aws-eu-central-1');
  });

  it('throws on an unknown region', () => {
    expect(() => assertRegion('mars-north-1')).toThrow(/unknown region/);
  });
});
