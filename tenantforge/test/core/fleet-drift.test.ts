import { describe, expect, it } from 'vitest';
import { computeFleetMigrationDrift } from '../../src/core/fleet-drift.js';

describe('computeFleetMigrationDrift', () => {
  it('flags tenants behind the latest catalog version', () => {
    const report = computeFleetMigrationDrift({
      versions: ['0001', '0002', '0003'],
      tenants: [
        { tenantId: 'a', applied: ['0001', '0002', '0003'], failed: [] }, // at latest
        { tenantId: 'b', applied: ['0001', '0002'], failed: [] }, // missing 0003
        { tenantId: 'c', applied: ['0001'], failed: ['0002'] }, // missing 0002+0003, 0002 failed
      ],
    });

    expect(report.latest).toBe('0003');
    expect(report.totalVersions).toBe(3);
    expect(report.tenants).toEqual([
      { tenantId: 'a', atLatest: true, missing: [], failed: [] },
      { tenantId: 'b', atLatest: false, missing: ['0003'], failed: [] },
      { tenantId: 'c', atLatest: false, missing: ['0002', '0003'], failed: ['0002'] },
    ]);
    expect(report.summary).toEqual({ total: 3, atLatest: 1, drifted: 2, withFailures: 1 });
  });

  it('treats every tenant as at-latest when the catalog is empty', () => {
    const report = computeFleetMigrationDrift({
      versions: [],
      tenants: [{ tenantId: 'a', applied: [], failed: [] }],
    });
    expect(report.latest).toBeNull();
    expect(report.summary).toEqual({ total: 1, atLatest: 1, drifted: 0, withFailures: 0 });
  });

  it('ignores failed versions not in the catalog and preserves catalog order in missing', () => {
    const report = computeFleetMigrationDrift({
      versions: ['0001', '0002'],
      tenants: [{ tenantId: 'a', applied: [], failed: ['0002', 'bogus'] }],
    });
    expect(report.tenants[0]!.missing).toEqual(['0001', '0002']);
    expect(report.tenants[0]!.failed).toEqual(['0002']); // 'bogus' dropped
  });

  it('handles an empty fleet', () => {
    const report = computeFleetMigrationDrift({ versions: ['0001'], tenants: [] });
    expect(report.summary).toEqual({ total: 0, atLatest: 0, drifted: 0, withFailures: 0 });
  });
});
