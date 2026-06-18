import { describe, expect, it } from 'vitest';
import { compliantRegions, selectRegion } from '../../src/core/residency-router.js';

describe('compliantRegions', () => {
  it('returns all known regions when no jurisdiction and no allow-list', () => {
    const all = compliantRegions({});
    expect(all).toContain('aws-us-east-1');
    expect(all).toContain('aws-eu-central-1');
    expect(all).toContain('aws-ap-southeast-1');
  });

  it('restricts to the allow-list when one is given', () => {
    expect(compliantRegions({ allowed: ['aws-eu-central-1', 'aws-us-east-1'] })).toEqual([
      'aws-us-east-1',
      'aws-eu-central-1',
    ]);
  });

  it('ignores unknown allow-list entries (intersects with KNOWN_REGIONS)', () => {
    expect(compliantRegions({ allowed: ['made-up-region', 'aws-us-west-2'] })).toEqual([
      'aws-us-west-2',
    ]);
  });

  it('filters by jurisdiction', () => {
    const eu = compliantRegions({ jurisdiction: 'eu' });
    expect(eu).toEqual(['aws-eu-central-1', 'aws-eu-west-1', 'aws-eu-west-2', 'azure-gwc']);
  });

  it('intersects allow-list and jurisdiction', () => {
    expect(
      compliantRegions({ jurisdiction: 'eu', allowed: ['aws-eu-west-1', 'aws-us-east-1'] }),
    ).toEqual(['aws-eu-west-1']);
  });

  it('returns empty when the allow-list excludes the jurisdiction', () => {
    expect(compliantRegions({ jurisdiction: 'apac', allowed: ['aws-us-east-1'] })).toEqual([]);
  });
});

describe('selectRegion', () => {
  it('returns the preferred region when it is compliant', () => {
    expect(selectRegion({ jurisdiction: 'eu', allowed: [], preferred: 'aws-eu-west-1' })).toBe(
      'aws-eu-west-1',
    );
  });

  it('falls back to the first compliant region when the preferred is not compliant', () => {
    // Preferred is a US region but EU residency is required → pick the first EU region.
    expect(selectRegion({ jurisdiction: 'eu', preferred: 'aws-us-east-1' })).toBe(
      'aws-eu-central-1',
    );
  });

  it('uses the first compliant region when no preference is given', () => {
    expect(selectRegion({ jurisdiction: 'apac' })).toBe('aws-ap-southeast-1');
  });

  it('honors the preferred region when there is no jurisdiction constraint', () => {
    expect(selectRegion({ preferred: 'azure-westus3' })).toBe('azure-westus3');
  });

  it('throws when no region satisfies the jurisdiction within the allow-list', () => {
    expect(() => selectRegion({ jurisdiction: 'apac', allowed: ['aws-us-east-1'] })).toThrow(
      /no region satisfies residency "apac" within the allowed regions \[aws-us-east-1\]/,
    );
  });

  it('throws ("any" jurisdiction) when the allow-list intersects to nothing known', () => {
    expect(() => selectRegion({ allowed: ['unknown-only'] })).toThrow(
      /no region satisfies residency "any" within the allowed regions \[unknown-only\]/,
    );
  });
});
