import { describe, expect, it } from 'vitest';
import { buildRetentionReport } from '../../src/core/retention-report.js';
import type { RetainableReportTenant } from '../../src/core/retention-report.js';

const now = new Date('2026-06-30T00:00:00.000Z');
const t = (over: Partial<RetainableReportTenant>): RetainableReportTenant => ({
  id: 't',
  slug: 's',
  status: 'offboarding',
  updatedAt: new Date('2026-06-20T00:00:00.000Z'),
  ...over,
});

describe('buildRetentionReport', () => {
  it('includes only offboarding tenants and computes eligibility + purge-eligible date', () => {
    const report = buildRetentionReport(
      [
        t({ id: 'old', updatedAt: new Date('2026-05-01T00:00:00.000Z') }), // 60d ago → eligible
        t({ id: 'recent', updatedAt: new Date('2026-06-25T00:00:00.000Z') }), // 5d ago → pending
        t({ id: 'active', status: 'active' }), // excluded
        t({ id: 'deleted', status: 'deleted' }), // excluded
      ],
      { now, retentionDays: 30 },
    );
    expect(report.tenants.map((r) => r.tenantId)).toEqual(['old', 'recent']);
    expect(report.eligible).toBe(1);
    expect(report.pending).toBe(1);
    expect(report.retentionDays).toBe(30);
    expect(report.generatedAt).toBe('2026-06-30T00:00:00.000Z');
    const old = report.tenants[0]!;
    expect(old.eligible).toBe(true);
    expect(old.archivedAt).toBe('2026-05-01T00:00:00.000Z');
    expect(old.purgeEligibleAt).toBe('2026-05-31T00:00:00.000Z'); // archived + 30d
  });

  it('orders eligible first, then soonest-eligible, then by id', () => {
    const report = buildRetentionReport(
      [
        t({ id: 'pending-late', updatedAt: new Date('2026-06-29T00:00:00.000Z') }),
        t({ id: 'pending-soon', updatedAt: new Date('2026-06-21T00:00:00.000Z') }),
        t({ id: 'eligible-b', updatedAt: new Date('2026-05-10T00:00:00.000Z') }),
        t({ id: 'eligible-a', updatedAt: new Date('2026-05-10T00:00:00.000Z') }),
      ],
      { now, retentionDays: 30 },
    );
    expect(report.tenants.map((r) => r.tenantId)).toEqual([
      'eligible-a', // eligible, same date → id tiebreak
      'eligible-b',
      'pending-soon', // pending, sooner purge-eligible date first
      'pending-late',
    ]);
  });

  it('treats retentionDays 0 as everything-eligible and rejects negative days', () => {
    const zero = buildRetentionReport([t({ id: 'x' })], { now, retentionDays: 0 });
    expect(zero.tenants[0]?.eligible).toBe(true);
    expect(() => buildRetentionReport([], { now, retentionDays: -1 })).toThrow(/retentionDays/);
  });

  it('returns an empty report when no tenants are archived', () => {
    const report = buildRetentionReport([t({ status: 'active' })], { now, retentionDays: 30 });
    expect(report.tenants).toEqual([]);
    expect(report.eligible).toBe(0);
    expect(report.pending).toBe(0);
  });
});
