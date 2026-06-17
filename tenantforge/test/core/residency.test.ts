import { describe, expect, it } from 'vitest';
import { KNOWN_REGIONS } from '../../src/core/regions.js';
import {
  KNOWN_JURISDICTIONS,
  assertRegionAllowed,
  assertResidency,
  regionJurisdiction,
} from '../../src/core/residency.js';

describe('regionJurisdiction', () => {
  it('maps every known region to a jurisdiction', () => {
    for (const region of KNOWN_REGIONS) {
      expect(KNOWN_JURISDICTIONS).toContain(regionJurisdiction(region));
    }
  });

  it('classifies representative regions', () => {
    expect(regionJurisdiction('aws-us-east-1')).toBe('us');
    expect(regionJurisdiction('aws-eu-central-1')).toBe('eu');
    expect(regionJurisdiction('azure-gwc')).toBe('eu');
    expect(regionJurisdiction('aws-ap-northeast-1')).toBe('apac');
  });

  it('throws for an unmapped region', () => {
    expect(() => regionJurisdiction('mars-north-1')).toThrow(/no residency jurisdiction/);
  });
});

describe('assertResidency', () => {
  it('passes when the region matches the required jurisdiction', () => {
    expect(() => assertResidency('aws-eu-central-1', 'eu')).not.toThrow();
  });

  it('fails closed on a residency mismatch', () => {
    expect(() => assertResidency('aws-us-east-1', 'eu')).toThrow(
      /does not satisfy required residency/,
    );
  });
});

describe('assertRegionAllowed', () => {
  it('allows any region when the allow-list is empty', () => {
    expect(() => assertRegionAllowed('aws-us-east-1', [])).not.toThrow();
  });

  it('permits a region in the allow-list', () => {
    expect(() => assertRegionAllowed('aws-eu-central-1', ['aws-eu-central-1'])).not.toThrow();
  });

  it('rejects a region outside a non-empty allow-list', () => {
    expect(() => assertRegionAllowed('aws-us-east-1', ['aws-eu-central-1'])).toThrow(
      /not in the allowed set/,
    );
  });
});
