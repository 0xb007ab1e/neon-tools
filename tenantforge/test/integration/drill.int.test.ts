import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgTenantRegistry } from '../../src/adapters/neon-pg/registry.js';

// Automated runbook game-day (registry layer): runs the exact `psql` assessment queries the
// operational runbooks tell an operator to run, against the REAL control-plane schema, so the
// documented procedures are proven executable — not just plausible. Needs only DATABASE_URL (no
// Neon API), so it self-skips when that is absent. The live-Neon path (provision/offboard/purge,
// per-tenant secret rotation) is drilled by provision.int.test.ts + queue.int.test.ts.
// See docs/runbooks/drill-report.md.
const databaseUrl = process.env.DATABASE_URL;
const ready = Boolean(databaseUrl);

describe.skipIf(!ready)('runbook registry-query drill (live Postgres)', () => {
  const registry = createPgTenantRegistry({ connectionString: databaseUrl! });
  const db = new Pool({ connectionString: databaseUrl! });
  // Unique per run so a drill never collides with real data or a concurrent drill.
  const tag = Date.now().toString(36);
  const slug = `drill-${tag}`;
  const version = `drill-${tag}`;
  let tenantId = '';
  let migrationId = '';

  beforeAll(async () => {
    // deploy.md step 2: `tenantforge migrate` → the registry schema exists / is current.
    await registry.migrate();
    // Seed a controlled fixture: one tenant stuck in `provisioning`, one fleet migration with a
    // `failed` per-tenant row — the exact state the runbooks query for.
    const t = await db.query<{ id: string }>(
      `INSERT INTO tf_tenants (slug, region, status)
       VALUES ($1, 'aws-us-east-1', 'provisioning') RETURNING id`,
      [slug],
    );
    tenantId = t.rows[0]!.id;
    const m = await db.query<{ id: string }>(
      `INSERT INTO tf_migrations (version, checksum) VALUES ($1, 'drill') RETURNING id`,
      [version],
    );
    migrationId = m.rows[0]!.id;
    await db.query(
      `INSERT INTO tf_tenant_migrations (tenant_id, migration_id, status, error, applied_at)
       VALUES ($1, $2, 'failed', 'drill: simulated timeout', NULL)`,
      [tenantId, migrationId],
    );
  });

  afterAll(async () => {
    if (migrationId) await db.query('DELETE FROM tf_migrations WHERE id = $1', [migrationId]); // cascades tf_tenant_migrations
    if (tenantId) await db.query('DELETE FROM tf_tenants WHERE id = $1', [tenantId]);
    await db.end();
    await registry.close();
  });

  it('backup-restore.md: registry status breakdown executes and includes the seeded tenant', async () => {
    const { rows } = await db.query<{ status: string; count: string }>(
      'SELECT status, count(*) FROM tf_tenants GROUP BY status',
    );
    const provisioning = rows.find((r) => r.status === 'provisioning');
    expect(provisioning).toBeDefined();
    expect(Number(provisioning!.count)).toBeGreaterThanOrEqual(1);
  });

  it('rollback.md: stuck-in-provisioning query finds the seeded tenant', async () => {
    const { rows } = await db.query<{ id: string; slug: string }>(
      "SELECT id, slug FROM tf_tenants WHERE status = 'provisioning'",
    );
    expect(rows.some((r) => r.slug === slug)).toBe(true);
  });

  it('fleet-migration-rollback.md §2: per-migration status counts execute for the version', async () => {
    const { rows } = await db.query<{ status: string; count: string }>(
      `SELECT tm.status, count(*) AS count
         FROM tf_tenant_migrations tm JOIN tf_migrations m ON m.id = tm.migration_id
        WHERE m.version = $1 GROUP BY tm.status`,
      [version],
    );
    const failed = rows.find((r) => r.status === 'failed');
    expect(failed).toBeDefined();
    expect(Number(failed!.count)).toBe(1);
  });

  it('fleet-migration-rollback.md §2: failure list returns the tenant id + error', async () => {
    const { rows } = await db.query<{ tenant_id: string; error: string }>(
      `SELECT tm.tenant_id, tm.error
         FROM tf_tenant_migrations tm JOIN tf_migrations m ON m.id = tm.migration_id
        WHERE m.version = $1 AND tm.status = 'failed'`,
      [version],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenant_id).toBe(tenantId);
    expect(rows[0]!.error).toContain('drill');
  });
});
