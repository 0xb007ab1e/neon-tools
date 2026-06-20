import { describe, expect, it } from 'vitest';
import { buildComplianceReport } from '../../src/core/compliance.js';
import type { TenantRecord } from '../../src/core/domain.js';

let seq = 0;
const tenant = (over: Partial<TenantRecord> = {}): TenantRecord => ({
  id: `t${(seq += 1)}`,
  slug: `slug-${seq}`,
  region: 'aws-us-east-1',
  status: 'active',
  neonProjectId: `proj-${seq}`,
  metadata: {},
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});

const now = new Date('2026-06-20T00:00:00.000Z');
const build = (tenants: TenantRecord[], allowedRegions?: string[]) =>
  buildComplianceReport(tenants, { now, ...(allowedRegions ? { allowedRegions } : {}) });

describe('buildComplianceReport', () => {
  it('attests a clean fleet (distinct projects, known regions, no allow-list)', () => {
    const r = build([
      tenant({ id: 'a', region: 'aws-us-east-1', neonProjectId: 'p1' }),
      tenant({ id: 'b', region: 'aws-eu-central-1', neonProjectId: 'p2' }),
    ]);
    expect(r.generatedAt).toBe('2026-06-20T00:00:00.000Z');
    expect(r.isolation.compliant).toBe(true);
    expect(r.residency.compliant).toBe(true);
    expect(r.residency.byJurisdiction).toEqual({ us: 1, eu: 1 });
    expect(r.inventory.total).toBe(2);
  });

  it('flags a missing project for a provisioned-status tenant', () => {
    const r = build([tenant({ id: 'a', status: 'active', neonProjectId: null })]);
    expect(r.isolation.compliant).toBe(false);
    expect(r.isolation.missingProject).toEqual(['a']);
  });

  it('does NOT flag a provisioning-status tenant without a project yet', () => {
    const r = build([tenant({ id: 'a', status: 'provisioning', neonProjectId: null })]);
    expect(r.isolation.missingProject).toEqual([]);
    expect(r.isolation.compliant).toBe(true);
  });

  it('flags a project id shared across tenants (cross-tenant isolation violation)', () => {
    const r = build([
      tenant({ id: 'b', neonProjectId: 'shared' }),
      tenant({ id: 'a', neonProjectId: 'shared' }),
    ]);
    expect(r.isolation.compliant).toBe(false);
    expect(r.isolation.sharedProjects).toEqual([
      { neonProjectId: 'shared', tenantIds: ['a', 'b'] },
    ]);
  });

  it('flags a region outside the org allow-list', () => {
    const r = build(
      [
        tenant({ id: 'a', region: 'aws-us-east-1' }),
        tenant({ id: 'b', region: 'aws-eu-central-1' }),
      ],
      ['aws-us-east-1'],
    );
    expect(r.residency.compliant).toBe(false);
    expect(r.residency.violations).toEqual([
      { tenantId: 'b', region: 'aws-eu-central-1', reason: 'region not in org allow-list' },
    ]);
  });

  it('flags an unknown region without crashing (no jurisdiction mapping)', () => {
    const r = build([tenant({ id: 'a', region: 'mars-1' })]);
    expect(r.residency.byJurisdiction).toEqual({ unknown: 1 });
    expect(r.residency.violations).toEqual([
      { tenantId: 'a', region: 'mars-1', reason: 'no known residency jurisdiction' },
    ]);
  });

  it('inventories deleted tenants but excludes them from attestations', () => {
    const r = build([
      tenant({ id: 'a', status: 'deleted', neonProjectId: null, region: 'mars-1' }),
      tenant({ id: 'b', status: 'active', neonProjectId: 'p1' }),
    ]);
    expect(r.inventory.total).toBe(2);
    expect(r.inventory.byStatus.deleted).toBe(1);
    expect(r.inventory.byStatus.active).toBe(1);
    // The deleted tenant's null project + mars-1 region must NOT count as violations.
    expect(r.isolation.compliant).toBe(true);
    expect(r.residency.compliant).toBe(true);
  });

  it('handles an empty fleet', () => {
    const r = build([]);
    expect(r.inventory.total).toBe(0);
    expect(r.isolation.compliant).toBe(true);
    expect(r.residency.compliant).toBe(true);
    expect(r.residency.byJurisdiction).toEqual({});
  });

  it('produces deterministic, sorted output (hashable)', () => {
    const a = build([
      tenant({ id: 'z', neonProjectId: 'pz' }),
      tenant({ id: 'a', neonProjectId: 'pa' }),
    ]);
    const b = build([
      tenant({ id: 'a', neonProjectId: 'pa' }),
      tenant({ id: 'z', neonProjectId: 'pz' }),
    ]);
    // identical inputs (modulo order) → identical serialization
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
