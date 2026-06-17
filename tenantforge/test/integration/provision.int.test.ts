import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createNeonProvisioningProvider } from '../../src/adapters/neon-api/provisioning-provider.js';
import { createPgTenantRegistry } from '../../src/adapters/neon-pg/registry.js';
import { createTenantForge } from '../../src/app/lib.js';

// Non-hermetic: needs a live Neon control-plane DB + Neon API. Self-skips when creds are absent.
const databaseUrl = process.env.DATABASE_URL;
const neonApiKey = process.env.NEON_API_KEY;
const neonOrgId = process.env.NEON_ORG_ID;
const ready = Boolean(databaseUrl && neonApiKey && neonOrgId);

describe.skipIf(!ready)('provision round-trip (live Neon)', () => {
  const registry = createPgTenantRegistry({ connectionString: databaseUrl! });
  const provisioning = createNeonProvisioningProvider({
    apiKey: neonApiKey!,
    orgId: neonOrgId!,
    ...(process.env.NEON_API_BASE_URL ? { baseUrl: process.env.NEON_API_BASE_URL } : {}),
  });
  const tf = createTenantForge({ registry, provisioning, defaultRegion: 'aws-us-east-1' });
  const cleanup = new Pool({ connectionString: databaseUrl! });

  // Unique per run so repeated runs don't collide on the slug.
  const slug = `it-${Date.now().toString(36)}`;
  let projectId: string | null = null;

  afterAll(async () => {
    if (projectId) await provisioning.deleteTenantProject(projectId);
    await cleanup.query('DELETE FROM tf_tenants WHERE slug = $1', [slug]);
    await cleanup.end();
    await tf.close();
  });

  it('provisions a tenant, records it active, then tears it down', async () => {
    await tf.migrate();
    const { tenant, connectionUri } = await tf.provision({ slug });
    projectId = tenant.neonProjectId;

    expect(tenant.status).toBe('active');
    expect(tenant.neonProjectId).toBeTruthy();
    expect(connectionUri).toBeTruthy();

    const fetched = await tf.getTenant(tenant.id);
    expect(fetched?.slug).toBe(slug);

    // Idempotent re-request returns the same tenant without a second project.
    const again = await tf.provision({ slug });
    expect(again.tenant.id).toBe(tenant.id);
    expect(again.connectionUri).toBeNull();
  });
});
