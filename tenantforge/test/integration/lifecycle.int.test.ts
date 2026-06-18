import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createNeonProvisioningProvider } from '../../src/adapters/neon-api/provisioning-provider.js';
import { createPgTenantRegistry } from '../../src/adapters/neon-pg/registry.js';
import { createInMemorySecretStore } from '../../src/adapters/secret-store.js';
import { createTenantForge } from '../../src/app/lib.js';

// Live-Neon game-day — full lifecycle smoke (the `deploy.md` smoke test + `backup-restore.md`
// "resume = restore" + the lifecycle state machine, end to end against real Neon). Provisions and
// then purges a throwaway tenant, so it leaves nothing behind. Self-skips without credentials.
// See docs/runbooks/game-day.md.
const databaseUrl = process.env.DATABASE_URL;
const neonApiKey = process.env.NEON_API_KEY;
const neonOrgId = process.env.NEON_ORG_ID;
const ready = Boolean(databaseUrl && neonApiKey && neonOrgId);

describe.skipIf(!ready)('lifecycle smoke (live Neon)', () => {
  const registry = createPgTenantRegistry({ connectionString: databaseUrl! });
  const provisioning = createNeonProvisioningProvider({
    apiKey: neonApiKey!,
    orgId: neonOrgId!,
    ...(process.env.NEON_API_BASE_URL ? { baseUrl: process.env.NEON_API_BASE_URL } : {}),
  });
  const tf = createTenantForge({
    registry,
    provisioning,
    secretStore: createInMemorySecretStore(),
    defaultRegion: 'aws-us-east-1',
  });
  const cleanup = new Pool({ connectionString: databaseUrl! });

  const slug = `gd-life-${Date.now().toString(36)}`;
  let projectId: string | null = null;
  let purged = false;

  afterAll(async () => {
    // If the test bailed before purge, delete the project so we never orphan a Neon project.
    if (projectId && !purged)
      await provisioning.deleteTenantProject(projectId).catch(() => undefined);
    await cleanup.query('DELETE FROM tf_tenants WHERE slug = $1', [slug]);
    await cleanup.end();
    await tf.close();
  });

  it('runs provision → suspend → resume → offboard → resume → purge with the documented states', async () => {
    await tf.migrate();

    // deploy.md smoke: provision → active + project id + a connection secret issued.
    const { tenant, connectionUri } = await tf.provision({ slug });
    projectId = tenant.neonProjectId;
    expect(tenant.status).toBe('active');
    expect(tenant.neonProjectId).toBeTruthy();
    expect(connectionUri).toBeTruthy();

    // Active tenant resolves a connection (fail-closed router opens for active + provisioned + secret).
    await expect(tf.getConnection(tenant.id)).resolves.toMatchObject({ tenantId: tenant.id });

    // suspend → routing is fail-closed.
    expect((await tf.suspend(tenant.id)).status).toBe('suspended');
    await expect(tf.getConnection(tenant.id)).rejects.toThrow();

    // resume → active again.
    expect((await tf.resume(tenant.id)).status).toBe('active');

    // offboard → archived (offboarding); project RETAINED (scale-to-zero), reversible.
    const offboarded = await tf.offboard(tenant.id);
    expect(offboarded.tenant.status).toBe('offboarding');

    // backup-restore.md: "resume = restore" — un-archive back to active within the retention window.
    expect((await tf.resume(tenant.id)).status).toBe('active');

    // offboard again, then purge → irreversible delete (project + secret gone).
    await tf.offboard(tenant.id);
    const deleted = await tf.purge(tenant.id);
    purged = true;
    expect(deleted.status).toBe('deleted');

    // A purged tenant no longer resolves a connection.
    await expect(tf.getConnection(tenant.id)).rejects.toThrow();
  });
});
