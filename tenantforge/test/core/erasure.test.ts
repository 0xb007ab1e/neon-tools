import { describe, expect, it } from 'vitest';
import type { TenantRecord } from '../../src/core/domain.js';
import { buildErasureCertificate, type ErasureSteps } from '../../src/core/erasure.js';

const tenant: TenantRecord = {
  id: 't1',
  slug: 'acme',
  region: 'aws-eu-central-1',
  status: 'deleted',
  neonProjectId: 'proj-1',
  metadata: {},
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

// A no-export baseline (no exportLocation); individual tests add an export where needed.
const base: ErasureSteps = {
  tenant,
  reason: 'GDPR Art.17',
  erasedAt: '2026-06-18T00:00:00.000Z',
  exported: false,
  projectDeleted: true,
  secretShredded: true,
  statusDeleted: true,
};

describe('buildErasureCertificate', () => {
  it('records the tenant, reason, and steps; verified when both post-conditions hold', () => {
    expect(
      buildErasureCertificate({ ...base, exported: true, exportLocation: 's3://exports/t1.dump' }),
    ).toEqual({
      tenantId: 't1',
      slug: 'acme',
      reason: 'GDPR Art.17',
      erasedAt: '2026-06-18T00:00:00.000Z',
      exported: true,
      exportLocation: 's3://exports/t1.dump',
      projectDeleted: true,
      verification: { secretShredded: true, statusDeleted: true },
      verified: true,
    });
  });

  it('omits exportLocation when no export was produced', () => {
    const cert = buildErasureCertificate(base);
    expect(cert.exported).toBe(false);
    expect('exportLocation' in cert).toBe(false);
  });

  it('is not verified when the secret was not shredded', () => {
    expect(buildErasureCertificate({ ...base, secretShredded: false }).verified).toBe(false);
  });

  it('is not verified when the status is not deleted', () => {
    expect(buildErasureCertificate({ ...base, statusDeleted: false }).verified).toBe(false);
  });
});
