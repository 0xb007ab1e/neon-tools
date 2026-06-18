import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createNeonProvisioningProvider } from '../../src/adapters/neon-api/provisioning-provider.js';
import { createPgTenantRegistry } from '../../src/adapters/neon-pg/registry.js';
import { createPgMigrationRunner } from '../../src/adapters/neon-pg/migration-runner.js';
import { createInMemorySecretStore } from '../../src/adapters/secret-store.js';
import { createTenantForge } from '../../src/app/lib.js';

// Live-Neon game-day — fleet migration + compensating revert (the heart of
// `fleet-migration-rollback.md`, run for real). Provisions a canary tenant, applies an additive
// fleet migration across the fleet, proves it is idempotent/resumable, applies a backward-compatible
// revert, then purges the canary. Self-skips without credentials. See docs/runbooks/game-day.md.
const databaseUrl = process.env.DATABASE_URL;
const neonApiKey = process.env.NEON_API_KEY;
const neonOrgId = process.env.NEON_ORG_ID;
const ready = Boolean(databaseUrl && neonApiKey && neonOrgId);

const tag = Date.now().toString(36);
const FORWARD = {
  version: `drill_${tag}_probe`,
  sql: 'CREATE TABLE IF NOT EXISTS tf_drill_probe (id int);',
};
const REVERT = {
  version: `drill_${tag}_probe_revert`,
  sql: 'DROP TABLE IF EXISTS tf_drill_probe;',
};

describe.skipIf(!ready)('fleet migration + revert (live Neon)', () => {
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
    migrationRunner: createPgMigrationRunner(),
    defaultRegion: 'aws-us-east-1',
  });
  const cleanup = new Pool({ connectionString: databaseUrl! });

  const slug = `gd-fleet-${tag}`;

  afterAll(async () => {
    // Purge the canary's project and clear all drill rows from the registry.
    const t = await cleanup.query<{ id: string; neon_project_id: string | null }>(
      'SELECT id, neon_project_id FROM tf_tenants WHERE slug = $1',
      [slug],
    );
    const row = t.rows[0];
    if (row?.neon_project_id)
      await provisioning.deleteTenantProject(row.neon_project_id).catch(() => undefined);
    await cleanup.query('DELETE FROM tf_migrations WHERE version = ANY($1)', [
      [FORWARD.version, REVERT.version],
    ]); // cascades tf_tenant_migrations
    await cleanup.query('DELETE FROM tf_tenants WHERE slug = $1', [slug]);
    await cleanup.end();
    await tf.close();
  });

  it('applies an additive fleet migration, is idempotent on re-run, then reverts', async () => {
    await tf.migrate();
    const { tenant } = await tf.provision({ slug });
    expect(tenant.status).toBe('active');

    // Apply the additive migration across the fleet.
    const forward = await tf.migrateFleet(FORWARD, { batchSize: 5 });
    expect(forward.succeeded).toContain(tenant.id);
    expect(forward.failed).toHaveLength(0);

    // fleet-migration-rollback.md §3c: re-running the same version is resumable — the applied
    // tenant is skipped, not re-applied.
    const rerun = await tf.migrateFleet(FORWARD, { batchSize: 5 });
    expect(rerun.alreadyApplied).toBeGreaterThanOrEqual(1);
    expect(rerun.succeeded).not.toContain(tenant.id);

    // fleet-migration-rollback.md §3b: a compensating, backward-compatible revert is itself a fleet
    // migration (DROP ... IF EXISTS — a safe no-op on tenants that never got the change).
    const revert = await tf.migrateFleet(REVERT, { batchSize: 5 });
    expect(revert.succeeded).toContain(tenant.id);
    expect(revert.failed).toHaveLength(0);
  });
});
