import { describe, expect, it } from 'vitest';
import type { TenantRecord } from '../../src/core/domain.js';
import { createNeonArchiveExporter } from '../../src/adapters/neon-archive-exporter.js';

const record = (neonProjectId: string | null): TenantRecord => ({
  id: 't1',
  slug: 'acme',
  region: 'aws-us-east-1',
  status: 'offboarding',
  neonProjectId,
  metadata: {},
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

describe('createNeonArchiveExporter', () => {
  it('references the retained Neon project as the archive', async () => {
    const result = await createNeonArchiveExporter().exportTenant(record('proj-1'));
    expect(result).toEqual({ location: 'neon-project:proj-1' });
  });

  it('handles a never-provisioned tenant (nothing to retain)', async () => {
    const result = await createNeonArchiveExporter().exportTenant(record(null));
    expect(result).toEqual({ location: 'none:unprovisioned' });
  });
});
