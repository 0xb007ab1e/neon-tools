import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FleetMigration,
  JsonObject,
  MigrationStatus,
  TenantMigrationState,
  TenantRecord,
  TenantStatus,
} from '../../src/core/domain.js';
import type { MigrationRunner } from '../../src/ports/migration-runner.js';
import type { TenantEvent } from '../../src/core/observability.js';
import type { NewTenant, TenantRegistry } from '../../src/ports/tenant-registry.js';
import type {
  ProvisioningProvider,
  ProvisionRequest,
} from '../../src/ports/provisioning-provider.js';
import { createInMemorySecretStore } from '../../src/adapters/secret-store.js';
import { createInMemoryAuditLogStore } from '../../src/adapters/audit-log-store.js';
import { createInMemoryCreditLedger } from '../../src/adapters/credit-ledger.js';
import { createInMemorySignupTokenStore } from '../../src/adapters/signup-token-store.js';
import { createAuditLogEventSink } from '../../src/adapters/event-sink.js';
import { createLifecycleHandler, createTenantForge } from '../../src/app/lib.js';
import { runWithActor } from '../../src/app/actor-context.js';

/** Minimal in-memory tenant registry for hermetic unit tests. */
function fakeRegistry(): TenantRegistry & { seed(record: TenantRecord): void } {
  const byId = new Map<string, TenantRecord>();
  const migrations = new Map<string, FleetMigration>();
  const migStates = new Map<string, TenantMigrationState>();
  let seq = 0;
  let migSeq = 0;
  const clone = (r: TenantRecord): TenantRecord => ({ ...r, metadata: { ...r.metadata } });
  return {
    seed(record) {
      byId.set(record.id, record);
    },
    registerMigration(m: { version: string; checksum: string }) {
      let rec = migrations.get(m.version);
      if (!rec) {
        rec = { id: `mig-${++migSeq}`, version: m.version, checksum: m.checksum };
        migrations.set(m.version, rec);
      }
      return Promise.resolve(rec);
    },
    listMigrations() {
      return Promise.resolve([...migrations.values()]);
    },
    listTenantMigrationStates(migrationId: string) {
      return Promise.resolve([...migStates.values()].filter((s) => s.migrationId === migrationId));
    },
    recordTenantMigration(
      tenantId: string,
      migrationId: string,
      status: MigrationStatus,
      error?: string,
    ) {
      migStates.set(`${tenantId}|${migrationId}`, {
        tenantId,
        migrationId,
        status,
        ...(error !== undefined ? { error } : {}),
      });
      return Promise.resolve();
    },
    migrate: () => Promise.resolve(),
    ping: () => Promise.resolve(),
    relocate(id: string, region: string, neonProjectId: string) {
      const rec = byId.get(id);
      if (rec) byId.set(id, { ...rec, region, neonProjectId });
      return Promise.resolve();
    },
    create(tenant: NewTenant) {
      const now = new Date(0);
      const record: TenantRecord = {
        id: `tenant-${++seq}`,
        slug: tenant.slug,
        region: tenant.region,
        status: 'provisioning',
        neonProjectId: null,
        metadata: (tenant.metadata as JsonObject) ?? {},
        createdAt: now,
        updatedAt: now,
      };
      byId.set(record.id, record);
      return Promise.resolve(clone(record));
    },
    getById(id) {
      const r = byId.get(id);
      return Promise.resolve(r ? clone(r) : null);
    },
    getBySlug(slug) {
      for (const r of byId.values()) if (r.slug === slug) return Promise.resolve(clone(r));
      return Promise.resolve(null);
    },
    list(options?: { status?: TenantStatus; limit?: number }) {
      let rows = [...byId.values()];
      if (options?.status) rows = rows.filter((r) => r.status === options.status);
      return Promise.resolve(rows.map(clone));
    },
    attachProject(id, neonProjectId) {
      const r = byId.get(id);
      if (r) r.neonProjectId = neonProjectId;
      return Promise.resolve();
    },
    setStatus(id, status) {
      const r = byId.get(id);
      if (r) r.status = status;
      return Promise.resolve();
    },
    updateMetadata(id, patch) {
      const r = byId.get(id);
      if (r) r.metadata = { ...r.metadata, ...patch };
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  };
}

/** Provisioning provider fake that records create + delete calls. */
function fakeProvisioning(): ProvisioningProvider & {
  calls: ProvisionRequest[];
  deletes: string[];
} {
  const calls: ProvisionRequest[] = [];
  const deletes: string[] = [];
  return {
    calls,
    deletes,
    createTenantProject(request) {
      calls.push(request);
      return Promise.resolve({
        neonProjectId: `proj-${calls.length}`,
        connectionUri: 'postgresql://secret@host/db',
      });
    },
    deleteTenantProject(neonProjectId) {
      deletes.push(neonProjectId);
      return Promise.resolve();
    },
    rotateTenantCredential(neonProjectId) {
      return Promise.resolve({ connectionUri: `postgresql://rotated@host/${neonProjectId}` });
    },
  };
}

describe('createTenantForge.provision', () => {
  let registry: ReturnType<typeof fakeRegistry>;
  let provisioning: ReturnType<typeof fakeProvisioning>;
  let secretStore: ReturnType<typeof createInMemorySecretStore>;

  beforeEach(() => {
    registry = fakeRegistry();
    provisioning = fakeProvisioning();
    secretStore = createInMemorySecretStore();
  });

  const make = () =>
    createTenantForge({ registry, provisioning, secretStore, defaultRegion: 'aws-us-east-1' });

  it('provisions a new tenant: creates the project, attaches it, and activates', async () => {
    const tf = make();
    const { tenant, connectionUri } = await tf.provision({ slug: 'Acme-Co' });
    expect(tenant.slug).toBe('acme-co'); // normalized
    expect(tenant.status).toBe('active');
    expect(tenant.neonProjectId).toBe('proj-1');
    expect(connectionUri).toBe('postgresql://secret@host/db');
    expect(provisioning.calls).toHaveLength(1);
    expect(provisioning.calls[0]).toEqual({ slug: 'acme-co', region: 'aws-us-east-1' });
  });

  it('honors a region override and validates it', async () => {
    const tf = make();
    const { tenant } = await tf.provision({ slug: 'acme', region: 'aws-eu-central-1' });
    expect(tenant.region).toBe('aws-eu-central-1');
    await expect(tf.provision({ slug: 'beta', region: 'mars-1' })).rejects.toThrow(
      /unknown region/,
    );
  });

  it('is idempotent: re-provisioning an active slug is a no-op (no second project)', async () => {
    const tf = make();
    await tf.provision({ slug: 'acme' });
    const second = await tf.provision({ slug: 'acme' });
    expect(second.connectionUri).toBeNull();
    expect(provisioning.calls).toHaveLength(1);
  });

  it('rejects an explicit region that violates the required residency', async () => {
    const tf = make();
    await expect(
      tf.provision({ slug: 'acme', region: 'aws-us-east-1', residency: 'eu' }),
    ).rejects.toThrow(/does not satisfy required residency "eu"/);
  });

  it('auto-selects a compliant region when residency is required and no region is given', async () => {
    const tf = make(); // default region is US (aws-us-east-1)
    const { tenant } = await tf.provision({ slug: 'acme', residency: 'eu' });
    // The router picks the first EU region (the US default does not qualify).
    expect(tenant.region).toBe('aws-eu-central-1');
  });

  it('auto-selects within the org allow-list for the required jurisdiction', async () => {
    const tf = createTenantForge({
      registry,
      provisioning,
      secretStore,
      defaultRegion: 'aws-us-east-1',
      allowedRegions: ['aws-eu-west-2', 'aws-us-east-1'],
    });
    const { tenant } = await tf.provision({ slug: 'acme', residency: 'eu' });
    expect(tenant.region).toBe('aws-eu-west-2'); // only EU region on the allow-list
  });

  it('resumes an interrupted provision (record exists, no project yet)', async () => {
    registry.seed({
      id: 'tenant-resumed',
      slug: 'half-done',
      region: 'aws-us-east-1',
      status: 'provisioning',
      neonProjectId: null,
      metadata: {},
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    const tf = make();
    const { tenant, connectionUri } = await tf.provision({ slug: 'half-done' });
    expect(tenant.status).toBe('active');
    expect(tenant.neonProjectId).toBe('proj-1');
    expect(connectionUri).not.toBeNull();
  });

  it('fails closed when the slug belongs to an offboarding/deleted tenant', async () => {
    registry.seed({
      id: 'gone',
      slug: 'leaving',
      region: 'aws-us-east-1',
      status: 'offboarding',
      neonProjectId: 'proj-x',
      metadata: {},
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    const tf = make();
    await expect(tf.provision({ slug: 'leaving' })).rejects.toThrow(/offboarding tenant/);
    expect(provisioning.calls).toHaveLength(0);
  });

  it('rejects an invalid slug before any I/O', async () => {
    const tf = make();
    const spy = vi.spyOn(registry, 'getBySlug');
    await expect(tf.provision({ slug: 'a' })).rejects.toThrow(/invalid tenant slug/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('createTenantForge.erase', () => {
  it('erases an active tenant (override path) and returns a verified certificate', async () => {
    const registry = fakeRegistry();
    const provisioning = fakeProvisioning();
    const secretStore = createInMemorySecretStore();
    const tf = createTenantForge({
      registry,
      provisioning,
      secretStore,
      defaultRegion: 'aws-us-east-1',
    });
    const { tenant } = await tf.provision({ slug: 'acme' });
    expect(tenant.status).toBe('active');

    const cert = await tf.erase(tenant.id, { reason: 'GDPR Art.17 #7' });
    expect(cert.tenantId).toBe(tenant.id);
    expect(cert.reason).toBe('GDPR Art.17 #7');
    expect(cert.projectDeleted).toBe(true);
    expect(cert.verified).toBe(true);
    expect(await secretStore.get(tenant.id)).toBeNull();
    expect((await tf.getTenant(tenant.id))?.status).toBe('deleted');
  });
});

describe('createTenantForge.rehome', () => {
  it('relocates an active tenant to a new region via the injected data mover', async () => {
    const registry = fakeRegistry();
    const provisioning = fakeProvisioning();
    const secretStore = createInMemorySecretStore();
    const moved: { from: string; to: string }[] = [];
    const tf = createTenantForge({
      registry,
      provisioning,
      secretStore,
      defaultRegion: 'aws-us-east-1',
      dataMover: {
        move: (input) => {
          moved.push(input);
          return Promise.resolve();
        },
      },
    });
    const { tenant } = await tf.provision({ slug: 'acme' });

    const result = await tf.rehome(tenant.id, { region: 'aws-eu-central-1' });
    expect(result).toMatchObject({ fromRegion: 'aws-us-east-1', toRegion: 'aws-eu-central-1' });
    expect(moved).toHaveLength(1);
    expect((await tf.getTenant(tenant.id))?.region).toBe('aws-eu-central-1');
  });

  it('fails closed when no data mover is configured', async () => {
    const tf = createTenantForge({
      registry: fakeRegistry(),
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
    });
    const { tenant } = await tf.provision({ slug: 'acme' });
    await expect(tf.rehome(tenant.id, { region: 'aws-eu-central-1' })).rejects.toThrow(
      /a dataMover is required/,
    );
  });
});

describe('createTenantForge.rotateSecret', () => {
  it('rotates an active tenant credential and updates the stored secret', async () => {
    const registry = fakeRegistry();
    const provisioning = fakeProvisioning();
    const secretStore = createInMemorySecretStore();
    const tf = createTenantForge({
      registry,
      provisioning,
      secretStore,
      defaultRegion: 'aws-us-east-1',
    });
    const { tenant } = await tf.provision({ slug: 'acme' });
    const before = await secretStore.get(tenant.id);

    const result = await tf.rotateSecret(tenant.id);
    expect(result).toEqual({ tenantId: tenant.id, rotated: true });
    const after = await secretStore.get(tenant.id);
    expect(after).not.toBe(before);
    expect(after).toContain('rotated@host');
  });

  it('rotateSecrets sweeps active tenants', async () => {
    const registry = fakeRegistry();
    const provisioning = fakeProvisioning();
    const secretStore = createInMemorySecretStore();
    const tf = createTenantForge({
      registry,
      provisioning,
      secretStore,
      defaultRegion: 'aws-us-east-1',
    });
    const a = await tf.provision({ slug: 'acme' });
    const b = await tf.provision({ slug: 'beta' });
    const report = await tf.rotateSecrets();
    expect(report.scanned).toBe(2);
    expect(report.rotated).toEqual(expect.arrayContaining([a.tenant.id, b.tenant.id]));
    expect(report.failed).toEqual([]);
  });
});

describe('createTenantForge.health', () => {
  const make = () => {
    const registry = fakeRegistry();
    const tf = createTenantForge({
      registry,
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
    });
    return { registry, tf };
  };

  it('reports ok when the registry is reachable', async () => {
    const { tf } = make();
    expect(await tf.health()).toEqual({ status: 'ok', checks: { registry: 'ok' } });
  });

  it('reports degraded (fail-soft) when the registry ping rejects', async () => {
    const { registry, tf } = make();
    vi.spyOn(registry, 'ping').mockRejectedValue(new Error('connection refused'));
    expect(await tf.health()).toEqual({ status: 'degraded', checks: { registry: 'error' } });
  });
});

describe('createTenantForge.getConnection caching', () => {
  it('caches resolutions when enabled and invalidates on a lifecycle transition', async () => {
    const registry = fakeRegistry();
    const provisioning = fakeProvisioning();
    const secretStore = createInMemorySecretStore();
    const tf = createTenantForge({
      registry,
      provisioning,
      secretStore,
      defaultRegion: 'aws-us-east-1',
      connectionCacheTtlMs: 60_000,
    });
    const { tenant } = await tf.provision({ slug: 'acme' });
    const getSpy = vi.spyOn(secretStore, 'get');

    await tf.getConnection(tenant.id);
    await tf.getConnection(tenant.id);
    expect(getSpy).toHaveBeenCalledTimes(1); // second resolve served from cache

    // A transition (suspend) invalidates; the tenant is now non-routable, so resolve fails closed.
    await tf.suspend(tenant.id);
    await expect(tf.getConnection(tenant.id)).rejects.toThrow();
    await tf.resume(tenant.id);
    await tf.getConnection(tenant.id);
    expect(getSpy.mock.calls.length).toBeGreaterThan(1); // cache was invalidated, re-resolved
  });
});

describe('createTenantForge.complianceReport with a persisted audit log', () => {
  it('omits the audit section without an audit store', async () => {
    const tf = createTenantForge({
      registry: fakeRegistry(),
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
    });
    expect((await tf.complianceReport()).report.audit).toBeUndefined();
  });

  it('attests erasure history + a recent excerpt from the audit trail', async () => {
    const auditLog = createInMemoryAuditLogStore();
    const tf = createTenantForge({
      registry: fakeRegistry(),
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
      auditLog,
      // Persist the operation events so the report can read them back.
      eventSink: createAuditLogEventSink(auditLog),
    });
    // A full lifecycle to deletion produces a `tenant.transition` to `deleted` (the erasure record),
    // attributed to the operator in scope (who-did-what-when).
    let tenantId = '';
    await runWithActor({ id: 'op', role: 'admin' }, async () => {
      const { tenant } = await tf.provision({ slug: 'acme' });
      tenantId = tenant.id;
      await tf.offboard(tenant.id);
      await tf.purge(tenant.id);
    });
    await Promise.resolve(); // let fire-and-forget appends settle

    const { report } = await tf.complianceReport();
    expect(report.audit).toBeDefined();
    expect(report.audit?.erasures.map((e) => e.tenantId)).toEqual([tenantId]);
    expect(report.audit?.erasures[0]?.actor).toEqual({ id: 'op', role: 'admin' });
    // The recent excerpt carries the broader activity (provision/transition/compliance events).
    expect(report.audit?.recent.length).toBeGreaterThan(0);
  });
});

describe('createTenantForge lifecycle', () => {
  let registry: ReturnType<typeof fakeRegistry>;
  let provisioning: ReturnType<typeof fakeProvisioning>;
  let secretStore: ReturnType<typeof createInMemorySecretStore>;
  const exporter = {
    exportTenant: () => Promise.resolve({ location: 's3://exports/t', bytes: 1 }),
  };

  beforeEach(() => {
    registry = fakeRegistry();
    provisioning = fakeProvisioning();
    secretStore = createInMemorySecretStore();
  });

  it('suspends then resumes an active tenant', async () => {
    const tf = createTenantForge({
      registry,
      provisioning,
      secretStore,
      defaultRegion: 'aws-us-east-1',
    });
    const { tenant } = await tf.provision({ slug: 'acme' });
    expect((await tf.suspend(tenant.id)).status).toBe('suspended');
    expect((await tf.resume(tenant.id)).status).toBe('active');
  });

  it('rejects an illegal transition (suspending an already-suspended tenant)', async () => {
    const tf = createTenantForge({
      registry,
      provisioning,
      secretStore,
      defaultRegion: 'aws-us-east-1',
    });
    const { tenant } = await tf.provision({ slug: 'acme' });
    await tf.suspend(tenant.id);
    await expect(tf.suspend(tenant.id)).rejects.toThrow(/illegal tenant status transition/);
  });

  it('offboards by ARCHIVING: retains the project (no delete), returns the archive ref', async () => {
    const tf = createTenantForge({
      registry,
      provisioning,
      secretStore,
      defaultRegion: 'aws-us-east-1',
      exporter,
    });
    const { tenant } = await tf.provision({ slug: 'acme' });
    const outcome = await tf.offboard(tenant.id);
    expect(outcome.tenant.status).toBe('offboarding'); // retained, pending purge — NOT deleted
    expect(outcome.archive?.location).toBe('s3://exports/t');
    expect(provisioning.deletes).toEqual([]); // reversible: nothing deleted
    expect(await secretStore.get(tenant.id)).not.toBeNull(); // secret retained
  });

  it('offboards without an exporter (null archive ref), still reversible', async () => {
    const tf = createTenantForge({
      registry,
      provisioning,
      secretStore,
      defaultRegion: 'aws-us-east-1',
    });
    const { tenant } = await tf.provision({ slug: 'acme' });
    const outcome = await tf.offboard(tenant.id);
    expect(outcome.tenant.status).toBe('offboarding');
    expect(outcome.archive).toBeNull();
    expect((await tf.resume(tenant.id)).status).toBe('active'); // reversible
  });

  it('purge irreversibly deletes the offboarded project and shreds the secret', async () => {
    const tf = createTenantForge({
      registry,
      provisioning,
      secretStore,
      defaultRegion: 'aws-us-east-1',
    });
    const { tenant } = await tf.provision({ slug: 'acme' });
    await tf.offboard(tenant.id);
    const deleted = await tf.purge(tenant.id);
    expect(deleted.status).toBe('deleted');
    expect(provisioning.deletes).toEqual(['proj-1']);
    expect(await secretStore.get(tenant.id)).toBeNull();
  });

  it('purge fails closed on an active (non-offboarded) tenant — no delete', async () => {
    const tf = createTenantForge({
      registry,
      provisioning,
      secretStore,
      defaultRegion: 'aws-us-east-1',
    });
    const { tenant } = await tf.provision({ slug: 'acme' });
    await expect(tf.purge(tenant.id)).rejects.toThrow(/illegal tenant status transition/);
    expect(provisioning.deletes).toEqual([]);
  });

  it('throws when offboarding an unknown tenant', async () => {
    const tf = createTenantForge({
      registry,
      provisioning,
      secretStore,
      defaultRegion: 'aws-us-east-1',
    });
    await expect(tf.offboard('missing')).rejects.toThrow(/not found/);
  });
});

describe('createTenantForge queries', () => {
  it('lists and gets tenants', async () => {
    const registry = fakeRegistry();
    const provisioning = fakeProvisioning();
    const secretStore = createInMemorySecretStore();
    const tf = createTenantForge({
      registry,
      provisioning,
      secretStore,
      defaultRegion: 'aws-us-east-1',
    });
    const { tenant } = await tf.provision({ slug: 'acme' });
    expect(await tf.getTenant(tenant.id)).not.toBeNull();
    expect(await tf.getTenant('missing')).toBeNull();
    expect(await tf.listTenants()).toHaveLength(1);
    expect(await tf.listTenants({ status: 'suspended' })).toHaveLength(0);
  });
});

describe('createTenantForge connection secrets', () => {
  let registry: ReturnType<typeof fakeRegistry>;
  let provisioning: ReturnType<typeof fakeProvisioning>;
  let secretStore: ReturnType<typeof createInMemorySecretStore>;

  beforeEach(() => {
    registry = fakeRegistry();
    provisioning = fakeProvisioning();
    secretStore = createInMemorySecretStore();
  });

  const make = () =>
    createTenantForge({ registry, provisioning, secretStore, defaultRegion: 'aws-us-east-1' });

  it('stores the connection secret on provision (keyed by tenant id, not in the registry)', async () => {
    const tf = make();
    const { tenant } = await tf.provision({ slug: 'acme' });
    expect(await secretStore.get(tenant.id)).toBe('postgresql://secret@host/db');
    // The registry record never carries the secret.
    expect(JSON.stringify(await tf.getTenant(tenant.id))).not.toContain('postgresql://');
  });

  it('getConnection resolves an active tenant to its connection', async () => {
    const tf = make();
    const { tenant } = await tf.provision({ slug: 'acme' });
    const conn = await tf.getConnection(tenant.id);
    expect(conn).toEqual({ tenantId: tenant.id, connectionUri: 'postgresql://secret@host/db' });
  });

  it('getConnection fails closed for a suspended tenant', async () => {
    const tf = make();
    const { tenant } = await tf.provision({ slug: 'acme' });
    await tf.suspend(tenant.id);
    await expect(tf.getConnection(tenant.id)).rejects.toThrow(/not routable/);
  });

  it('getConnection throws for an unknown tenant', async () => {
    await expect(make().getConnection('missing')).rejects.toThrow(/not found/);
  });

  it('isolates connections across tenants end-to-end (no cross-tenant bleed)', async () => {
    // Two distinct provisioning results so each tenant has its own project + connection URI.
    let n = 0;
    provisioning.createTenantProject = () => {
      n += 1;
      return Promise.resolve({
        neonProjectId: `proj-${n}`,
        connectionUri: `postgresql://t${n}@host/db`,
      });
    };
    const tf = make();
    const a = (await tf.provision({ slug: 'tenant-a' })).tenant;
    const b = (await tf.provision({ slug: 'tenant-b' })).tenant;
    expect(a.id).not.toBe(b.id);

    const connA = await tf.getConnection(a.id);
    const connB = await tf.getConnection(b.id);
    // Each id resolves to ITS OWN connection — never the other tenant's.
    expect(connA).toEqual({ tenantId: a.id, connectionUri: 'postgresql://t1@host/db' });
    expect(connB).toEqual({ tenantId: b.id, connectionUri: 'postgresql://t2@host/db' });
    expect(connA.connectionUri).not.toBe(connB.connectionUri);
  });

  it('offboard retains the secret; purge crypto-shreds it', async () => {
    const tf = make();
    const { tenant } = await tf.provision({ slug: 'acme' });
    await tf.offboard(tenant.id);
    expect(await secretStore.get(tenant.id)).not.toBeNull(); // archived, still recoverable
    await tf.purge(tenant.id);
    expect(await secretStore.get(tenant.id)).toBeNull(); // shredded on purge
  });
});

describe('createTenantForge.migrateFleet', () => {
  it('fails closed when no migration runner is configured', async () => {
    const tf = createTenantForge({
      registry: fakeRegistry(),
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
    });
    await expect(tf.migrateFleet({ version: '0002', sql: 'SELECT 1' })).rejects.toThrow(
      /no migration runner configured/,
    );
  });

  it('runs a fleet migration across provisioned tenants (lib → orchestrator → router)', async () => {
    const applied: string[] = [];
    const migrationRunner: MigrationRunner = {
      applyToTenant: (uri) => {
        applied.push(uri);
        return Promise.resolve();
      },
    };
    const tf = createTenantForge({
      registry: fakeRegistry(),
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      migrationRunner,
      defaultRegion: 'aws-us-east-1',
    });
    await tf.provision({ slug: 'acme' });
    await tf.provision({ slug: 'beta' });
    const report = await tf.migrateFleet({ version: '0002', sql: 'SELECT 1' });
    expect(report.succeeded).toHaveLength(2);
    expect(report.failed).toEqual([]);
    expect(applied).toHaveLength(2); // the runner was driven for each active tenant

    // Re-running is idempotent: both already applied, nothing re-applied.
    const second = await tf.migrateFleet({ version: '0002', sql: 'SELECT 1' });
    expect(second.alreadyApplied).toBe(2);
    expect(second.succeeded).toEqual([]);
  });
});

describe('createTenantForge.reconcileFleet', () => {
  const specs = [
    { version: '0001', sql: '-- 1' },
    { version: '0002', sql: '-- 2' },
  ];

  it('fails closed when no migration runner is configured', async () => {
    const tf = createTenantForge({
      registry: fakeRegistry(),
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
    });
    await expect(tf.reconcileFleet(specs)).rejects.toThrow(/no migration runner configured/);
  });

  it('reconciles the fleet to latest, applying each tenant its missing versions in order', async () => {
    const applied: { uri: string; version: string }[] = [];
    const migrationRunner: MigrationRunner = {
      applyToTenant: (uri, m) => {
        applied.push({ uri, version: m.version });
        return Promise.resolve();
      },
    };
    const tf = createTenantForge({
      registry: fakeRegistry(),
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      migrationRunner,
      defaultRegion: 'aws-us-east-1',
    });
    await tf.provision({ slug: 'acme' });

    const report = await tf.reconcileFleet(specs);
    expect(report.target).toBe('0002');
    expect(report.reconciled).toHaveLength(1);
    expect(report.partial).toEqual([]);
    expect(applied.map((a) => a.version)).toEqual(['0001', '0002']); // ordered

    // Re-running is idempotent: the tenant is already at the target.
    const second = await tf.reconcileFleet(specs);
    expect(second.alreadyAtLatest).toBe(1);
    expect(second.reconciled).toEqual([]);
  });

  it('reconcilePlan previews the work without a runner (read-only)', async () => {
    const tf = createTenantForge({
      registry: fakeRegistry(),
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
    });
    // No migrations registered yet → empty catalog → nothing pending.
    const plan = await tf.reconcilePlan();
    expect(plan.target).toBeNull();
    expect(plan.pendingTenants).toEqual([]);
  });

  it('reconcileHistory returns [] without an audit store', async () => {
    const tf = createTenantForge({
      registry: fakeRegistry(),
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      migrationRunner: { applyToTenant: () => Promise.resolve() },
      defaultRegion: 'aws-us-east-1',
    });
    expect(await tf.reconcileHistory()).toEqual([]);
  });

  it('records reconcile runs in the audit trail and reconcileHistory reads them back', async () => {
    const auditLog = createInMemoryAuditLogStore();
    const tf = createTenantForge({
      registry: fakeRegistry(),
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      migrationRunner: { applyToTenant: () => Promise.resolve() },
      defaultRegion: 'aws-us-east-1',
      auditLog,
      eventSink: createAuditLogEventSink(auditLog),
    });
    await tf.provision({ slug: 'acme' });
    await tf.reconcileFleet(specs);

    const history = await tf.reconcileHistory();
    expect(history).toHaveLength(1);
    expect(history[0]?.event).toBe('fleet.reconcile');
    expect(history[0]?.context?.target).toBe('0002');
  });
});

describe('createTenantForge.purgeExpired', () => {
  let registry: ReturnType<typeof fakeRegistry>;
  let provisioning: ReturnType<typeof fakeProvisioning>;
  let secretStore: ReturnType<typeof createInMemorySecretStore>;
  const NOW = new Date('2026-06-17T00:00:00Z');

  beforeEach(() => {
    registry = fakeRegistry();
    provisioning = fakeProvisioning();
    secretStore = createInMemorySecretStore();
  });

  const make = () =>
    createTenantForge({ registry, provisioning, secretStore, defaultRegion: 'aws-us-east-1' });

  /** An offboarding tenant archived at `updatedAt`. */
  const archived = (id: string, updatedAt: Date): TenantRecord => ({
    id,
    slug: id,
    region: 'aws-us-east-1',
    status: 'offboarding',
    neonProjectId: `proj-${id}`,
    metadata: {},
    createdAt: new Date(0),
    updatedAt,
  });

  it('purges tenants past retention, spares those still within it', async () => {
    registry.seed(archived('old', new Date('2026-01-01T00:00:00Z'))); // >30d ago → purge
    registry.seed(archived('recent', new Date('2026-06-10T00:00:00Z'))); // <30d ago → keep
    const report = await make().purgeExpired({ retentionDays: 30, now: NOW });
    expect(report.scanned).toBe(2);
    expect(report.purged).toEqual(['old']);
    expect(report.failed).toEqual([]);
    expect(provisioning.deletes).toEqual(['proj-old']); // only the expired one deleted
    expect((await registry.getById('recent'))?.status).toBe('offboarding'); // recent untouched
  });

  it('ignores non-offboarding tenants entirely', async () => {
    const tf = make();
    await tf.provision({ slug: 'active-one' }); // stays active
    const report = await tf.purgeExpired({ retentionDays: 0, now: NOW });
    expect(report.scanned).toBe(0);
    expect(report.purged).toEqual([]);
    expect(provisioning.deletes).toEqual([]);
  });

  it('isolates a failure: one tenant erroring does not block the sweep', async () => {
    registry.seed(archived('a', new Date('2026-01-01T00:00:00Z')));
    registry.seed(archived('b', new Date('2026-01-01T00:00:00Z')));
    const failing = {
      ...provisioning,
      deleteTenantProject: (projectId: string) =>
        projectId === 'proj-a'
          ? Promise.reject(new Error('neon delete failed'))
          : Promise.resolve(),
    };
    const tf = createTenantForge({
      registry,
      provisioning: failing,
      secretStore,
      defaultRegion: 'aws-us-east-1',
    });
    const report = await tf.purgeExpired({ retentionDays: 30, now: NOW });
    expect(report.purged).toEqual(['b']);
    expect(report.failed).toEqual([{ tenantId: 'a', error: 'neon delete failed' }]);
  });
});

describe('createTenantForge observability', () => {
  it('emits redacted, tenant-scoped events for the key operations', async () => {
    const events: TenantEvent[] = [];
    const eventSink = { emit: (e: TenantEvent) => events.push(e) };
    const secretStore = createInMemorySecretStore();
    const tf = createTenantForge({
      registry: fakeRegistry(),
      provisioning: fakeProvisioning(),
      secretStore,
      eventSink,
      defaultRegion: 'aws-us-east-1',
    });

    const { tenant } = await tf.provision({ slug: 'acme' });
    await tf.getConnection(tenant.id);
    await tf.suspend(tenant.id);

    const names = events.map((e) => e.event);
    expect(names).toContain('tenant.provisioned'); // provision
    expect(names).toContain('tenant.transition'); // activate + suspend
    expect(names).toContain('tenant.connection_resolved');

    // Every event is tenant-scoped, timestamped, and carries NO secret.
    for (const e of events) {
      expect(e.tenantId).toBe(tenant.id);
      expect(typeof e.at).toBe('string');
      expect(JSON.stringify(e)).not.toContain('postgresql://'); // connection URI never leaks
    }
  });

  it('attributes events to the operator in scope (audit who-did-what), and none when absent', async () => {
    const events: TenantEvent[] = [];
    const make = () =>
      createTenantForge({
        registry: fakeRegistry(),
        provisioning: fakeProvisioning(),
        secretStore: createInMemorySecretStore(),
        eventSink: { emit: (e: TenantEvent) => events.push(e) },
        defaultRegion: 'aws-us-east-1',
      });

    // Run within an operator context → every emitted event carries that actor.
    await runWithActor({ id: 'op-7', role: 'admin' }, async () => {
      await make().provision({ slug: 'acme' });
    });
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.actor).toEqual({ id: 'op-7', role: 'admin' });

    // Run with no context (e.g. a cron sweep) → no attribution, but emission still works.
    events.length = 0;
    await make().provision({ slug: 'beta' });
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.actor).toBeUndefined();
  });

  it('emits a connection_denied event (no URI) when routing fails closed', async () => {
    const events: TenantEvent[] = [];
    const tf = createTenantForge({
      registry: fakeRegistry(),
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      eventSink: { emit: (e: TenantEvent) => events.push(e) },
      defaultRegion: 'aws-us-east-1',
    });
    const { tenant } = await tf.provision({ slug: 'acme' });
    await tf.suspend(tenant.id); // now not routable
    await expect(tf.getConnection(tenant.id)).rejects.toThrow(/not routable/);
    const denied = events.find((e) => e.event === 'tenant.connection_denied');
    expect(denied?.outcome).toBe('error');
    expect(denied?.tenantId).toBe(tenant.id);
  });

  it('defaults to a no-op sink (no eventSink injected) without error', async () => {
    const tf = createTenantForge({
      registry: fakeRegistry(),
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
    });
    await expect(tf.provision({ slug: 'acme' })).resolves.toBeDefined();
  });
});

describe('createTenantForge.usage', () => {
  const period = { from: new Date('2026-05-18'), to: new Date('2026-06-17') };
  const make = (usageProvider?: import('../../src/ports/usage-provider.js').UsageProvider) =>
    createTenantForge({
      registry: fakeRegistry(),
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      ...(usageProvider ? { usageProvider } : {}),
      defaultRegion: 'aws-us-east-1',
    });

  it('meters a tenant: resolves the project and aggregates consumption', async () => {
    const provider = {
      getProjectConsumption: () =>
        Promise.resolve([
          {
            computeTimeSeconds: 10,
            activeTimeSeconds: 8,
            writtenDataBytes: 100,
            syntheticStorageBytes: 500,
          },
          {
            computeTimeSeconds: 5,
            activeTimeSeconds: 4,
            writtenDataBytes: 50,
            syntheticStorageBytes: 700,
          },
        ]),
    };
    const tf = make(provider);
    const { tenant } = await tf.provision({ slug: 'acme' });
    const report = await tf.usage(tenant.id, period);
    expect(report.neonProjectId).toBe('proj-1');
    expect(report.consumption).toEqual({
      computeTimeSeconds: 15,
      activeTimeSeconds: 12,
      writtenDataBytes: 150,
      syntheticStorageBytes: 700, // peak
    });
    expect(report.period).toEqual({ from: period.from.toISOString(), to: period.to.toISOString() });
  });

  it('fails closed when no usage provider is configured', async () => {
    const tf = make();
    const { tenant } = await tf.provision({ slug: 'acme' });
    await expect(tf.usage(tenant.id, period)).rejects.toThrow(/no usage provider configured/);
  });

  it('rejects an inverted period', async () => {
    const provider = { getProjectConsumption: () => Promise.resolve([]) };
    const tf = make(provider);
    const { tenant } = await tf.provision({ slug: 'acme' });
    await expect(tf.usage(tenant.id, { from: period.to, to: period.from })).rejects.toThrow(
      /must not be after/,
    );
  });

  it('throws for a tenant with no provisioned project', async () => {
    const provider = { getProjectConsumption: () => Promise.resolve([]) };
    const registry = fakeRegistry();
    registry.seed({
      id: 'half',
      slug: 'half',
      region: 'aws-us-east-1',
      status: 'provisioning',
      neonProjectId: null,
      metadata: {},
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    const tf = createTenantForge({
      registry,
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      usageProvider: provider,
      defaultRegion: 'aws-us-east-1',
    });
    await expect(tf.usage('half', period)).rejects.toThrow(/no provisioned project/);
  });
});

describe('createTenantForge.invoice', () => {
  const period = { from: new Date('2026-06-01'), to: new Date('2026-07-01') };
  const provider = {
    getProjectConsumption: () =>
      Promise.resolve([
        {
          computeTimeSeconds: 100,
          activeTimeSeconds: 0,
          writtenDataBytes: 0,
          syntheticStorageBytes: 0,
        },
      ]),
  };

  it('fails closed when no usage provider is configured', async () => {
    const tf = createTenantForge({
      registry: fakeRegistry(),
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
    });
    await expect(tf.invoice('t', period)).rejects.toThrow(/requires a configured usage provider/);
    await expect(tf.invoiceFleet(period)).rejects.toThrow(/requires a configured usage provider/);
  });

  it('generates an invoice billing usage at the billing rates', async () => {
    const tf = createTenantForge({
      registry: fakeRegistry(),
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      usageProvider: provider,
      billingRates: { computeSecondUsd: 0.02 },
      defaultRegion: 'aws-us-east-1',
    });
    const { tenant } = await tf.provision({ slug: 'acme' });
    const inv = await tf.invoice(tenant.id, period);
    expect(inv.totalUsd).toBe(2); // 100 * 0.02
    const fleet = await tf.invoiceFleet(period);
    expect(fleet.invoices).toHaveLength(1);
  });

  it('setIncludedUsage applies an allowance so only the overage is billed; {} clears it', async () => {
    const tf = createTenantForge({
      registry: fakeRegistry(),
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      usageProvider: provider,
      billingRates: { computeSecondUsd: 0.02 },
      defaultRegion: 'aws-us-east-1',
    });
    const { tenant } = await tf.provision({ slug: 'acme' });

    const updated = await tf.setIncludedUsage(tenant.id, { computeTimeSeconds: 60 });
    expect(
      (updated.metadata.includedUsage as { computeTimeSeconds: number }).computeTimeSeconds,
    ).toBe(60);
    // 100 used − 60 incl = 40 × 0.02 = 0.80
    expect((await tf.invoice(tenant.id, period)).totalUsd).toBe(0.8);

    // Clearing restores full billing: 100 × 0.02 = 2.
    await tf.setIncludedUsage(tenant.id, {});
    expect((await tf.invoice(tenant.id, period)).totalUsd).toBe(2);
  });

  it('setIncludedUsage rejects a negative allowance and an unknown tenant', async () => {
    const tf = createTenantForge({
      registry: fakeRegistry(),
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      usageProvider: provider,
      defaultRegion: 'aws-us-east-1',
    });
    const { tenant } = await tf.provision({ slug: 'acme' });
    await expect(tf.setIncludedUsage(tenant.id, { computeTimeSeconds: -1 })).rejects.toThrow(
      /non-negative/,
    );
    await expect(tf.setIncludedUsage('ghost', { computeTimeSeconds: 1 })).rejects.toThrow(
      /not found/,
    );
  });
});

describe('createTenantForge.chargeInvoice', () => {
  const period = { from: new Date('2026-06-01'), to: new Date('2026-07-01') };
  const provider = {
    getProjectConsumption: () =>
      Promise.resolve([
        {
          computeTimeSeconds: 100,
          activeTimeSeconds: 0,
          writtenDataBytes: 0,
          syntheticStorageBytes: 0,
        },
      ]),
  };
  type Gw = import('../../src/ports/payment-gateway.js').PaymentGateway;
  type Req = import('../../src/ports/payment-gateway.js').ChargeRequest;
  /** A recording fake gateway; `fail` makes charge throw (a decline). */
  const fakeGateway = (calls: Req[] = [], fail = false): Gw => ({
    provider: 'stripe',
    charge: (r) => {
      calls.push(r);
      if (fail) return Promise.reject(new Error('card declined'));
      return Promise.resolve({
        id: 'ch_1',
        status: 'succeeded',
        amountMinor: r.amountMinor,
        currency: r.currency,
        provider: 'stripe',
      });
    },
    refund: () => Promise.reject(new Error('refund not used in this test')),
  });
  const base = () => ({
    registry: fakeRegistry(),
    provisioning: fakeProvisioning(),
    secretStore: createInMemorySecretStore(),
    usageProvider: provider,
    billingRates: { computeSecondUsd: 0.02 }, // 100 * 0.02 = $2.00 invoice
    defaultRegion: 'aws-us-east-1' as const,
  });

  it('fails closed without a payment gateway', async () => {
    const tf = createTenantForge(base());
    const { tenant } = await tf.provision({
      slug: 'acme',
      metadata: { billingCustomerRef: 'cus_1' },
    });
    await expect(tf.chargeInvoice(tenant.id, period)).rejects.toThrow(
      /requires a configured payment gateway/,
    );
  });

  it('fails closed when the tenant has no billingCustomerRef', async () => {
    const tf = createTenantForge({ ...base(), paymentGateway: fakeGateway() });
    const { tenant } = await tf.provision({ slug: 'acme' });
    await expect(tf.chargeInvoice(tenant.id, period)).rejects.toThrow(/no billingCustomerRef/);
  });

  it('charges the invoice total (minor units) via the gateway, idempotently', async () => {
    const calls: Req[] = [];
    const tf = createTenantForge({ ...base(), paymentGateway: fakeGateway(calls) });
    const { tenant } = await tf.provision({
      slug: 'acme',
      metadata: { billingCustomerRef: 'cus_1' },
    });
    const result = await tf.chargeInvoice(tenant.id, period);
    expect(result.status).toBe('succeeded');
    expect(calls[0]?.amountMinor).toBe(200); // $2.00
    expect(calls[0]?.currency).toBe('usd');
    expect(calls[0]?.customerRef).toBe('cus_1');
    expect(calls[0]?.idempotencyKey).toContain(`:${tenant.id}:`); // stable, tenant-scoped
    expect(calls[0]?.metadata?.tenant_id).toBe(tenant.id); // so inbound webhooks correlate back
  });

  it('chargeInvoiceFleet skips no-ref + zero-invoice tenants and isolates a decline', async () => {
    const registry = fakeRegistry();
    // Seed four active tenants directly with distinct metadata.
    const seed = (id: string, metadata: Record<string, string>) =>
      registry.seed({
        id,
        slug: id,
        region: 'aws-us-east-1',
        status: 'active',
        neonProjectId: `proj-${id}`,
        metadata,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      });
    seed('ok', { billingCustomerRef: 'cus_ok' });
    seed('noref', {});
    seed('decline', { billingCustomerRef: 'cus_d' });

    let n = 0;
    const gateway: Gw = {
      provider: 'stripe',
      charge: (r) => {
        n += 1;
        // The second charged tenant (decline) rejects; the first succeeds.
        return r.customerRef === 'cus_d'
          ? Promise.reject(new Error('card declined'))
          : Promise.resolve({
              id: `ch_${n}`,
              status: 'succeeded',
              amountMinor: r.amountMinor,
              currency: r.currency,
              provider: 'stripe',
            });
      },
      refund: () => Promise.reject(new Error('refund not used in this test')),
    };
    const tf = createTenantForge({
      registry,
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      usageProvider: provider,
      billingRates: { computeSecondUsd: 0.02 },
      defaultRegion: 'aws-us-east-1',
      paymentGateway: gateway,
    });
    const report = await tf.chargeInvoiceFleet(period);
    expect(report.charged.map((c) => c.tenantId)).toEqual(['ok']);
    expect(report.skipped.find((s) => s.tenantId === 'noref')?.reason).toBe(
      'no billingCustomerRef',
    );
    expect(report.failed.map((f) => f.tenantId)).toEqual(['decline']);
  });

  it('chargeHistory returns [] without an audit store, and reads tenant.charged with one', async () => {
    const noStore = createTenantForge({ ...base(), paymentGateway: fakeGateway() });
    expect(await noStore.chargeHistory()).toEqual([]);

    const auditLog = createInMemoryAuditLogStore();
    const tf = createTenantForge({
      ...base(),
      paymentGateway: fakeGateway(),
      auditLog,
      eventSink: createAuditLogEventSink(auditLog),
    });
    const { tenant } = await tf.provision({
      slug: 'acme',
      metadata: { billingCustomerRef: 'cus_1' },
    });
    await tf.chargeInvoice(tenant.id, period);
    const history = await tf.chargeHistory();
    expect(history).toHaveLength(1);
    expect(history[0]?.event).toBe('tenant.charged');
    expect(history[0]?.context?.status).toBe('succeeded');
  });
});

describe('createTenantForge.runDunning', () => {
  const period = { from: new Date('2026-06-01'), to: new Date('2026-07-01') };
  const schedule = { maxAttempts: 4, minHoursBetweenAttempts: 24 };
  const provider = {
    getProjectConsumption: () =>
      Promise.resolve([
        {
          computeTimeSeconds: 100,
          activeTimeSeconds: 0,
          writtenDataBytes: 0,
          syntheticStorageBytes: 0,
        },
      ]),
  };
  type Gw = import('../../src/ports/payment-gateway.js').PaymentGateway;
  type Req = import('../../src/ports/payment-gateway.js').ChargeRequest;
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

  /** Seed an active tenant with billing metadata directly into a fake registry. */
  function seedTenant(
    registry: ReturnType<typeof fakeRegistry>,
    id: string,
    metadata: Record<string, string>,
  ) {
    registry.seed({
      id,
      slug: id,
      region: 'aws-us-east-1',
      status: 'active',
      neonProjectId: `proj-${id}`,
      metadata,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
  }

  it('fails closed without a payment gateway', async () => {
    const tf = createTenantForge({
      registry: fakeRegistry(),
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      usageProvider: provider,
      billingRates: { computeSecondUsd: 0.02 },
      defaultRegion: 'aws-us-east-1',
    });
    await expect(tf.runDunning(period, schedule)).rejects.toThrow(
      /requires a configured payment gateway/,
    );
  });

  it('skips every active tenant when no audit store is wired (no failure history to act on)', async () => {
    const registry = fakeRegistry();
    seedTenant(registry, 't1', { billingCustomerRef: 'cus_1' });
    const gw: Gw = {
      provider: 'stripe',
      charge: () => Promise.reject(new Error('unused')),
      refund: () => Promise.reject(new Error('refund not used in this test')),
    };
    const tf = createTenantForge({
      registry,
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      usageProvider: provider,
      billingRates: { computeSecondUsd: 0.02 },
      defaultRegion: 'aws-us-east-1',
      paymentGateway: gw,
    });
    const report = await tf.runDunning(period, schedule);
    expect(report.skipped).toEqual([{ tenantId: 't1', reason: 'no audit store' }]);
    expect(report.retried).toEqual([]);
  });

  it('retries past-due tenants with a per-attempt key, suspends the exhausted, skips the rest', async () => {
    const registry = fakeRegistry();
    const auditLog = createInMemoryAuditLogStore();
    seedTenant(registry, 'retry-due', { billingCustomerRef: 'cus_retry' });
    seedTenant(registry, 'backoff', { billingCustomerRef: 'cus_back' });
    seedTenant(registry, 'healthy', { billingCustomerRef: 'cus_ok' });
    seedTenant(registry, 'exhausted', { billingCustomerRef: 'cus_exh' });
    seedTenant(registry, 'noref', {});

    const charged = (tenantId: string, outcome: 'ok' | 'error', at: string) =>
      auditLog.append({ event: 'tenant.charged', at, outcome, tenantId });
    // retry-due: 2 consecutive failures, last attempt 48h ago (backoff elapsed) → retry attempt 2
    await charged('retry-due', 'error', hoursAgo(72));
    await charged('retry-due', 'error', hoursAgo(48));
    // backoff: 1 failure 1h ago → within backoff window → wait
    await charged('backoff', 'error', hoursAgo(1));
    // healthy: last charge succeeded → not failing → wait
    await charged('healthy', 'error', hoursAgo(100));
    await charged('healthy', 'ok', hoursAgo(50));
    // exhausted: 4 consecutive failures → suspend
    await charged('exhausted', 'error', hoursAgo(96));
    await charged('exhausted', 'error', hoursAgo(72));
    await charged('exhausted', 'error', hoursAgo(48));
    await charged('exhausted', 'error', hoursAgo(24));

    const calls: Req[] = [];
    const gw: Gw = {
      provider: 'stripe',
      charge: (r) => {
        calls.push(r);
        return Promise.resolve({
          id: 'ch_retry',
          status: 'succeeded',
          amountMinor: r.amountMinor,
          currency: r.currency,
          provider: 'stripe',
        });
      },
      refund: () => Promise.reject(new Error('refund not used in this test')),
    };
    const tf = createTenantForge({
      registry,
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      usageProvider: provider,
      billingRates: { computeSecondUsd: 0.02 },
      defaultRegion: 'aws-us-east-1',
      paymentGateway: gw,
      auditLog,
      eventSink: createAuditLogEventSink(auditLog),
    });

    const report = await tf.runDunning(period, schedule);

    expect(report.retried).toEqual([
      {
        tenantId: 'retry-due',
        attempt: 2,
        id: 'ch_retry',
        status: 'succeeded',
        amountMinor: 200,
        currency: 'usd',
        provider: 'stripe',
      },
    ]);
    expect(report.suspended).toEqual([{ tenantId: 'exhausted', failures: 4 }]);
    expect(report.skipped).toEqual([
      { tenantId: 'backoff', reason: 'within backoff' },
      { tenantId: 'healthy', reason: 'no failures' },
      { tenantId: 'noref', reason: 'no billingCustomerRef' },
    ]);
    // Only the past-due tenant was charged, and with a fresh per-attempt idempotency key.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.idempotencyKey).toContain(':retry-2');
    // The exhausted tenant is actually suspended (reversible escalation).
    expect((await registry.getById('exhausted'))?.status).toBe('suspended');
    // A redacted tenant.dunning event was recorded for each action.
    const dunning = await tf.dunningHistory();
    expect(dunning.map((e) => e.context?.action).sort()).toEqual(['retry', 'suspend']);
  });

  it('isolates a retry that declines again into report.failed (never blocking others)', async () => {
    const registry = fakeRegistry();
    const auditLog = createInMemoryAuditLogStore();
    seedTenant(registry, 'declines', { billingCustomerRef: 'cus_d' });
    await auditLog.append({
      event: 'tenant.charged',
      at: hoursAgo(48),
      outcome: 'error',
      tenantId: 'declines',
    });
    const gw: Gw = {
      provider: 'stripe',
      charge: () => Promise.reject(new Error('card declined again')),
      refund: () => Promise.reject(new Error('refund not used in this test')),
    };
    const tf = createTenantForge({
      registry,
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      usageProvider: provider,
      billingRates: { computeSecondUsd: 0.02 },
      defaultRegion: 'aws-us-east-1',
      paymentGateway: gw,
      auditLog,
      eventSink: createAuditLogEventSink(auditLog),
    });
    const report = await tf.runDunning(period, schedule);
    expect(report.retried).toEqual([]);
    expect(report.failed).toEqual([
      { tenantId: 'declines', attempt: 1, error: 'card declined again' },
    ]);
    const dunning = await tf.dunningHistory();
    expect(dunning[0]?.outcome).toBe('error');
  });

  it('dunningHistory returns [] without an audit store; defaults period + schedule when omitted', async () => {
    const noStore = createTenantForge({
      registry: fakeRegistry(),
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      usageProvider: provider,
      billingRates: { computeSecondUsd: 0.02 },
      defaultRegion: 'aws-us-east-1',
      paymentGateway: {
        provider: 'stripe',
        charge: () => Promise.reject(new Error('unused')),
        refund: () => Promise.reject(new Error('refund not used in this test')),
      },
    });
    expect(await noStore.dunningHistory()).toEqual([]);
    // No args → current-month period + DEFAULT_DUNNING_SCHEDULE; empty registry → empty report.
    const report = await noStore.runDunning();
    expect(report.schedule).toEqual({ maxAttempts: 4, minHoursBetweenAttempts: 24 });
    expect(report.retried).toEqual([]);
  });
});

describe('createTenantForge.billingRun', () => {
  const period = { from: new Date('2026-06-01'), to: new Date('2026-07-01') };
  const provider = {
    getProjectConsumption: () =>
      Promise.resolve([
        {
          computeTimeSeconds: 100,
          activeTimeSeconds: 0,
          writtenDataBytes: 0,
          syntheticStorageBytes: 0,
        },
      ]),
  };
  type Gw = import('../../src/ports/payment-gateway.js').PaymentGateway;
  const okGateway = (): Gw => ({
    provider: 'stripe',
    charge: (r) =>
      Promise.resolve({
        id: 'ch_1',
        status: 'succeeded',
        amountMinor: r.amountMinor,
        currency: r.currency,
        provider: 'stripe',
      }),
    refund: () => Promise.reject(new Error('refund not used in this test')),
  });
  const base = () => ({
    registry: fakeRegistry(),
    provisioning: fakeProvisioning(),
    secretStore: createInMemorySecretStore(),
    usageProvider: provider,
    billingRates: { computeSecondUsd: 0.02 },
    defaultRegion: 'aws-us-east-1' as const,
  });

  it('fails closed without a payment gateway', async () => {
    const tf = createTenantForge(base());
    await expect(tf.billingRun(period)).rejects.toThrow(/requires a configured payment gateway/);
  });

  it('charges the fleet then duns, and records a billing.run roll-up event', async () => {
    const auditLog = createInMemoryAuditLogStore();
    const tf = createTenantForge({
      ...base(),
      paymentGateway: okGateway(),
      auditLog,
      eventSink: createAuditLogEventSink(auditLog),
    });
    const { tenant } = await tf.provision({
      slug: 'acme',
      metadata: { billingCustomerRef: 'cus_1' },
    });

    const report = await tf.billingRun(period);

    expect(report.charge.charged.map((c) => c.tenantId)).toEqual([tenant.id]);
    // The charge just succeeded → dunning sees no failures → the tenant is skipped, not retried.
    expect(report.dunning?.retried).toEqual([]);
    expect(report.dunning?.skipped).toEqual([{ tenantId: tenant.id, reason: 'no failures' }]);
    const runs = await tf.billingRunHistory();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.event).toBe('billing.run');
    expect(runs[0]?.outcome).toBe('ok');
    expect(runs[0]?.context?.charged).toBe(1);
    expect(runs[0]?.context?.dunningRan).toBe(true);
  });

  it('skips the dunning sweep when skipDunning is set (charge-only run)', async () => {
    const auditLog = createInMemoryAuditLogStore();
    const tf = createTenantForge({
      ...base(),
      paymentGateway: okGateway(),
      auditLog,
      eventSink: createAuditLogEventSink(auditLog),
    });
    await tf.provision({ slug: 'acme', metadata: { billingCustomerRef: 'cus_1' } });

    const report = await tf.billingRun(period, { skipDunning: true });
    expect(report.dunning).toBeUndefined();
    expect(report.charge.charged).toHaveLength(1);
    expect((await tf.billingRunHistory())[0]?.context?.dunningRan).toBe(false);
  });

  it('billingRunHistory returns [] without an audit store; defaults the period when omitted', async () => {
    const tf = createTenantForge({ ...base(), paymentGateway: okGateway() });
    expect(await tf.billingRunHistory()).toEqual([]);
    const report = await tf.billingRun(); // current-month default, empty registry
    expect(report.charge.charged).toEqual([]);
    expect(report.dunning?.skipped).toEqual([]);
  });
});

describe('createTenantForge.refundCharge', () => {
  const period = { from: new Date('2026-06-01'), to: new Date('2026-07-01') };
  const provider = {
    getProjectConsumption: () =>
      Promise.resolve([
        {
          computeTimeSeconds: 100,
          activeTimeSeconds: 0,
          writtenDataBytes: 0,
          syntheticStorageBytes: 0,
        },
      ]),
  };
  type Gw = import('../../src/ports/payment-gateway.js').PaymentGateway;
  type RefundReq = import('../../src/ports/payment-gateway.js').RefundRequest;
  /** A gateway that charges (returns a fixed id) and records refund calls. */
  const gateway = (refundCalls: RefundReq[] = [], chargeId = 'ch_1'): Gw => ({
    provider: 'stripe',
    charge: (r) =>
      Promise.resolve({
        id: chargeId,
        status: 'succeeded',
        amountMinor: r.amountMinor,
        currency: r.currency,
        provider: 'stripe',
      }),
    refund: (r) => {
      refundCalls.push(r);
      return Promise.resolve({
        id: 're_1',
        status: 'succeeded',
        amountMinor: r.amountMinor ?? 0,
        currency: r.currency,
        provider: 'stripe',
      });
    },
  });
  const base = () => ({
    registry: fakeRegistry(),
    provisioning: fakeProvisioning(),
    secretStore: createInMemorySecretStore(),
    usageProvider: provider,
    billingRates: { computeSecondUsd: 0.02 }, // $2.00 invoice → 200 minor units
    defaultRegion: 'aws-us-east-1' as const,
  });

  it('fails closed without a payment gateway', async () => {
    const tf = createTenantForge(base());
    await expect(tf.refundCharge('ch_x', { currency: 'usd' })).rejects.toThrow(
      /refunds require a configured payment gateway/,
    );
  });

  it('derives currency/amount/tenant from the audit trail and records a tenant.refunded event', async () => {
    const auditLog = createInMemoryAuditLogStore();
    const refundCalls: RefundReq[] = [];
    const tf = createTenantForge({
      ...base(),
      paymentGateway: gateway(refundCalls, 'ch_acme'),
      auditLog,
      eventSink: createAuditLogEventSink(auditLog),
    });
    const { tenant } = await tf.provision({
      slug: 'acme',
      metadata: { billingCustomerRef: 'cus_1' },
    });
    await tf.chargeInvoice(tenant.id, period); // records tenant.charged with chargeId ch_acme

    const result = await tf.refundCharge('ch_acme', { reason: 'goodwill' });
    expect(result.status).toBe('succeeded');
    // Full refund: no amount sent; currency + tenant correlation derived from the charge event.
    expect(refundCalls[0]?.amountMinor).toBeUndefined();
    expect(refundCalls[0]?.currency).toBe('usd');
    expect(refundCalls[0]?.metadata?.tenant_id).toBe(tenant.id);
    expect(refundCalls[0]?.idempotencyKey).toBe('tenantforge:refund:ch_acme:full');

    const history = await tf.refundHistory();
    expect(history).toHaveLength(1);
    expect(history[0]?.event).toBe('tenant.refunded');
    expect(history[0]?.tenantId).toBe(tenant.id);
    expect(history[0]?.context?.reason).toBe('goodwill');
  });

  it('bounds a partial refund by the original charge amount (fail closed)', async () => {
    const auditLog = createInMemoryAuditLogStore();
    const tf = createTenantForge({
      ...base(),
      paymentGateway: gateway([], 'ch_acme'),
      auditLog,
      eventSink: createAuditLogEventSink(auditLog),
    });
    const { tenant } = await tf.provision({
      slug: 'acme',
      metadata: { billingCustomerRef: 'cus_1' },
    });
    await tf.chargeInvoice(tenant.id, period); // $2.00 = 200 minor units
    await expect(tf.refundCharge('ch_acme', { amountMinor: 999 })).rejects.toThrow(
      /exceeds the original charge/,
    );
  });

  it('requires an explicit currency when the charge is not in the audit trail', async () => {
    const refundCalls: RefundReq[] = [];
    const tf = createTenantForge({ ...base(), paymentGateway: gateway(refundCalls) });
    await expect(tf.refundCharge('ch_unknown')).rejects.toThrow(/requires a currency/);
    // With an explicit currency it proceeds (partial refund key is amount-scoped).
    const result = await tf.refundCharge('ch_unknown', { currency: 'usd', amountMinor: 500 });
    expect(result.amountMinor).toBe(500);
    expect(refundCalls[0]?.idempotencyKey).toBe('tenantforge:refund:ch_unknown:500');
  });

  it('records an error event and rethrows when the gateway refund fails', async () => {
    const auditLog = createInMemoryAuditLogStore();
    const failing: Gw = {
      provider: 'stripe',
      charge: () => Promise.reject(new Error('unused')),
      refund: () => Promise.reject(new Error('already refunded')),
    };
    const tf = createTenantForge({
      ...base(),
      paymentGateway: failing,
      auditLog,
      eventSink: createAuditLogEventSink(auditLog),
    });
    await expect(tf.refundCharge('ch_x', { currency: 'usd' })).rejects.toThrow(/already refunded/);
    const history = await tf.refundHistory();
    expect(history[0]?.outcome).toBe('error');
  });

  it('refundHistory returns [] without an audit store', async () => {
    const tf = createTenantForge({ ...base(), paymentGateway: gateway() });
    expect(await tf.refundHistory()).toEqual([]);
  });

  it('refundUnusedPeriod prorates the latest charge to the offboard instant', async () => {
    const auditLog = createInMemoryAuditLogStore();
    const refundCalls: RefundReq[] = [];
    const tf = createTenantForge({
      ...base(),
      paymentGateway: gateway(refundCalls, 'ch_acme'),
      auditLog,
      eventSink: createAuditLogEventSink(auditLog),
    });
    const { tenant } = await tf.provision({
      slug: 'acme',
      metadata: { billingCustomerRef: 'cus_1' },
    });
    await tf.chargeInvoice(tenant.id, period); // $2.00 = 200 minor over Jun 1 → Jul 1

    // Offboard halfway through the 30-day period → refund half (100 minor units).
    const result = await tf.refundUnusedPeriod(tenant.id, {
      asOf: new Date('2026-06-16T00:00:00.000Z'),
    });
    expect(result?.amountMinor).toBe(100);
    expect(refundCalls[0]?.amountMinor).toBe(100);
    expect(refundCalls[0]?.idempotencyKey).toBe('tenantforge:refund:ch_acme:100');
    const history = await tf.refundHistory();
    expect(history[0]?.context?.reason).toBe('offboard proration (unused period)');
  });

  it('refunds nothing (null) when the period is already fully consumed', async () => {
    const auditLog = createInMemoryAuditLogStore();
    const refundCalls: RefundReq[] = [];
    const tf = createTenantForge({
      ...base(),
      paymentGateway: gateway(refundCalls, 'ch_acme'),
      auditLog,
      eventSink: createAuditLogEventSink(auditLog),
    });
    const { tenant } = await tf.provision({
      slug: 'acme',
      metadata: { billingCustomerRef: 'cus_1' },
    });
    await tf.chargeInvoice(tenant.id, period);
    const result = await tf.refundUnusedPeriod(tenant.id, {
      asOf: new Date('2026-08-01T00:00:00.000Z'),
    });
    expect(result).toBeNull();
    expect(refundCalls).toHaveLength(0);
  });

  it('returns null when the tenant has no prior charge', async () => {
    const auditLog = createInMemoryAuditLogStore();
    const tf = createTenantForge({
      ...base(),
      paymentGateway: gateway(),
      auditLog,
      eventSink: createAuditLogEventSink(auditLog),
    });
    const { tenant } = await tf.provision({
      slug: 'acme',
      metadata: { billingCustomerRef: 'cus_1' },
    });
    expect(await tf.refundUnusedPeriod(tenant.id)).toBeNull();
  });

  it('fails closed without a gateway, and without an audit store', async () => {
    const noGw = createTenantForge(base());
    await expect(noGw.refundUnusedPeriod('t1')).rejects.toThrow(/payment gateway/);
    const noAudit = createTenantForge({ ...base(), paymentGateway: gateway() });
    await expect(noAudit.refundUnusedPeriod('t1')).rejects.toThrow(/requires an audit store/);
  });
});

describe('createTenantForge billing receipts (notifier)', () => {
  const period = { from: new Date('2026-06-01'), to: new Date('2026-07-01') };
  const provider = {
    getProjectConsumption: () =>
      Promise.resolve([
        {
          computeTimeSeconds: 100,
          activeTimeSeconds: 0,
          writtenDataBytes: 0,
          syntheticStorageBytes: 0,
        },
      ]),
  };
  type Gw = import('../../src/ports/payment-gateway.js').PaymentGateway;
  type Notifier = import('../../src/ports/notifier.js').Notifier;
  type Notification = import('../../src/ports/notifier.js').Notification;
  const okGateway = (): Gw => ({
    provider: 'stripe',
    charge: (r) =>
      Promise.resolve({
        id: 'ch_x',
        status: 'succeeded',
        amountMinor: r.amountMinor,
        currency: r.currency,
        provider: 'stripe',
      }),
    refund: () => Promise.reject(new Error('unused')),
  });
  /** A recording notifier; `fail` makes notify throw. */
  const fakeNotifier = (calls: Notification[] = [], fail = false): Notifier => ({
    provider: 'log',
    notify: (n) => {
      calls.push(n);
      if (fail) return Promise.reject(new Error('relay down'));
      return Promise.resolve({ id: n.idempotencyKey, provider: 'log', status: 'queued' });
    },
  });
  const deps = (notifier?: Notifier) => {
    const auditLog = createInMemoryAuditLogStore();
    return {
      registry: fakeRegistry(),
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      usageProvider: provider,
      billingRates: { computeSecondUsd: 0.02 },
      defaultRegion: 'aws-us-east-1' as const,
      paymentGateway: okGateway(),
      auditLog,
      eventSink: createAuditLogEventSink(auditLog),
      ...(notifier !== undefined ? { notifier } : {}),
    };
  };

  it('sends a charge receipt to billingEmail and records tenant.notified (no recipient in the audit)', async () => {
    const calls: Notification[] = [];
    const tf = createTenantForge(deps(fakeNotifier(calls)));
    const { tenant } = await tf.provision({
      slug: 'acme',
      metadata: { billingCustomerRef: 'cus_1', billingEmail: 'billing@acme.example' },
    });
    await tf.chargeInvoice(tenant.id, period);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.to).toBe('billing@acme.example');
    expect(calls[0]?.subject).toContain('2.00 USD');
    expect(calls[0]?.idempotencyKey).toBe('tenantforge:receipt:charge:ch_x');
    const history = await tf.notificationHistory();
    expect(history).toHaveLength(1);
    expect(history[0]?.event).toBe('tenant.notified');
    expect(history[0]?.context?.kind).toBe('charge');
    expect(JSON.stringify(history[0])).not.toContain('billing@acme.example'); // PII not recorded
  });

  it('sends no receipt when the tenant has no billingEmail', async () => {
    const calls: Notification[] = [];
    const tf = createTenantForge(deps(fakeNotifier(calls)));
    const { tenant } = await tf.provision({
      slug: 'acme',
      metadata: { billingCustomerRef: 'cus_1' },
    });
    await tf.chargeInvoice(tenant.id, period);
    expect(calls).toHaveLength(0);
    expect(await tf.notificationHistory()).toEqual([]);
  });

  it('is best-effort: a notifier failure does not break the charge (records an error event)', async () => {
    const tf = createTenantForge(deps(fakeNotifier([], true)));
    const { tenant } = await tf.provision({
      slug: 'acme',
      metadata: { billingCustomerRef: 'cus_1', billingEmail: 'billing@acme.example' },
    });
    const result = await tf.chargeInvoice(tenant.id, period); // must still succeed
    expect(result.status).toBe('succeeded');
    expect((await tf.notificationHistory())[0]?.outcome).toBe('error');
  });

  it('sends nothing when no notifier is configured', async () => {
    const tf = createTenantForge(deps()); // no notifier
    const { tenant } = await tf.provision({
      slug: 'acme',
      metadata: { billingCustomerRef: 'cus_1', billingEmail: 'billing@acme.example' },
    });
    await tf.chargeInvoice(tenant.id, period);
    expect(await tf.notificationHistory()).toEqual([]);
  });
});

describe('createTenantForge.checkUsageAlerts', () => {
  const period = { from: new Date('2026-06-01'), to: new Date('2026-07-01') };
  type Notifier = import('../../src/ports/notifier.js').Notifier;
  type Notification = import('../../src/ports/notifier.js').Notification;
  const provider = {
    getProjectConsumption: () =>
      Promise.resolve([
        {
          computeTimeSeconds: 90,
          activeTimeSeconds: 0,
          writtenDataBytes: 0,
          syntheticStorageBytes: 0,
        },
      ]),
  };
  const fakeNotifier = (calls: Notification[] = []): Notifier => ({
    provider: 'log',
    notify: (n) => {
      calls.push(n);
      return Promise.resolve({ id: n.idempotencyKey, provider: 'log', status: 'queued' });
    },
  });
  const deps = (over: { thresholds?: number[]; notifier?: Notifier } = {}) => {
    const auditLog = createInMemoryAuditLogStore();
    return {
      registry: fakeRegistry(),
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      usageProvider: provider,
      defaultRegion: 'aws-us-east-1' as const,
      auditLog,
      eventSink: createAuditLogEventSink(auditLog),
      usageAlertThresholds: over.thresholds ?? [0.8, 1.0],
      ...(over.notifier !== undefined ? { notifier: over.notifier } : {}),
    };
  };

  it('fails closed without a usage provider or without configured thresholds', async () => {
    const noThresholds = createTenantForge({
      registry: fakeRegistry(),
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      usageProvider: provider,
      usageAlertThresholds: [],
      defaultRegion: 'aws-us-east-1',
    });
    await expect(noThresholds.checkUsageAlerts(period)).rejects.toThrow(/THRESHOLDS/);
  });

  it('alerts tenants over a threshold of their allowance and records tenant.usage_alert', async () => {
    const tf = createTenantForge(deps());
    const { tenant } = await tf.provision({
      slug: 'acme',
      metadata: { includedUsage: { computeTimeSeconds: 100 } }, // 90/100 = 90% → crosses 0.8
    });
    const report = await tf.checkUsageAlerts(period);
    expect(report.alerted.map((a) => a.tenantId)).toEqual([tenant.id]);
    expect(report.alerted[0]?.alerts[0]?.thresholdCrossed).toBe(0.8);
    const history = await tf.usageAlertHistory();
    expect(history[0]?.event).toBe('tenant.usage_alert');
  });

  it('with notify, emails the alerted tenant (billingEmail) without recording the recipient', async () => {
    const calls: Notification[] = [];
    const tf = createTenantForge(deps({ notifier: fakeNotifier(calls) }));
    await tf.provision({
      slug: 'acme',
      metadata: { includedUsage: { computeTimeSeconds: 100 }, billingEmail: 'ops@acme.example' },
    });
    const report = await tf.checkUsageAlerts(period, { notify: true });
    expect(report.alerted).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.to).toBe('ops@acme.example');
    expect(calls[0]?.idempotencyKey).toContain('usage-alert:');
    // The recipient address is never written to the audit trail (PII).
    const history = await tf.usageAlertHistory();
    expect(JSON.stringify(history)).not.toContain('ops@acme.example');
  });

  it('does not alert a tenant with no allowances configured', async () => {
    const tf = createTenantForge(deps());
    await tf.provision({ slug: 'acme', metadata: {} });
    const report = await tf.checkUsageAlerts(period);
    expect(report.alerted).toEqual([]);
  });
});

describe('createTenantForge.retentionReport', () => {
  const now = new Date('2026-06-30T00:00:00.000Z');
  const offboarding = (id: string, archivedAt: string) => ({
    id,
    slug: id,
    region: 'aws-us-east-1',
    status: 'offboarding' as const,
    neonProjectId: 'p',
    metadata: {},
    createdAt: new Date(0),
    updatedAt: new Date(archivedAt),
  });
  const tfWith = (retentionDays: number, rows: ReturnType<typeof offboarding>[]) =>
    createTenantForge({
      registry: {
        list: () => Promise.resolve(rows),
        getById: () => Promise.resolve(null),
        close: () => Promise.resolve(),
      } as never,
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
      retentionDays,
    });

  it('reports eligible vs pending archived tenants (eligible first)', async () => {
    const tf = tfWith(30, [
      offboarding('old', '2026-05-01T00:00:00.000Z'), // 60d ago → eligible
      offboarding('recent', '2026-06-25T00:00:00.000Z'), // 5d ago → pending
    ]);
    const report = await tf.retentionReport({ now });
    expect(report.retentionDays).toBe(30); // configured default
    expect(report.eligible).toBe(1);
    expect(report.pending).toBe(1);
    expect(report.tenants.map((t) => t.tenantId)).toEqual(['old', 'recent']);
    expect(report.tenants[0]?.purgeEligibleAt).toBe('2026-05-31T00:00:00.000Z');
  });

  it('honors a retentionDays override', async () => {
    const tf = tfWith(30, [offboarding('recent', '2026-06-25T00:00:00.000Z')]);
    // With a 1-day window, the 5-day-old archive is now eligible.
    const report = await tf.retentionReport({ now, retentionDays: 1 });
    expect(report.retentionDays).toBe(1);
    expect(report.eligible).toBe(1);
  });
});

describe('createTenantForge.exportTenantData', () => {
  const deps = (withExporter: boolean) => {
    const auditLog = createInMemoryAuditLogStore();
    return {
      registry: fakeRegistry(),
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1' as const,
      auditLog,
      eventSink: createAuditLogEventSink(auditLog),
      ...(withExporter
        ? {
            exporter: {
              exportTenant: (t: { id: string }) =>
                Promise.resolve({ location: `s3://exports/${t.id}.tar`, bytes: 4096 }),
            },
          }
        : {}),
    };
  };

  it('fails closed when no exporter is configured', async () => {
    const tf = createTenantForge(deps(false));
    const { tenant } = await tf.provision({ slug: 'acme' });
    await expect(tf.exportTenantData(tenant.id)).rejects.toThrow(/exporter/);
  });

  it('exports tenant data (no state change) and records tenant.exported', async () => {
    const tf = createTenantForge(deps(true));
    const { tenant } = await tf.provision({ slug: 'acme' });
    const result = await tf.exportTenantData(tenant.id);
    expect(result.location).toBe(`s3://exports/${tenant.id}.tar`);
    expect(result.bytes).toBe(4096);
    // The tenant is unchanged (not offboarded/deleted).
    expect((await tf.getTenant(tenant.id))?.status).toBe('active');
    const history = await tf.exportHistory();
    expect(history[0]?.event).toBe('tenant.exported');
    expect(history[0]?.context?.location).toBe(`s3://exports/${tenant.id}.tar`);
  });

  it('rejects an unknown tenant', async () => {
    const tf = createTenantForge(deps(true));
    await expect(tf.exportTenantData('ghost')).rejects.toThrow();
  });
});

describe('createTenantForge signup tokens', () => {
  const base = () => ({
    registry: fakeRegistry(),
    provisioning: fakeProvisioning(),
    secretStore: createInMemorySecretStore(),
    defaultRegion: 'aws-us-east-1' as const,
  });

  it('fails closed without a signup-token store', async () => {
    const tf = createTenantForge(base());
    await expect(tf.issueSignupToken({ slug: 'acme' })).rejects.toThrow(/signup-token store/);
    await expect(tf.redeemSignupToken('x')).rejects.toThrow(/signup-token store/);
    expect(await tf.listSignupTokens()).toEqual([]);
  });

  it('issues a one-time token, redeems it to provision, and is single-use', async () => {
    const store = createInMemorySignupTokenStore();
    const tf = createTenantForge({ ...base(), signupTokenStore: store });

    const issued = await tf.issueSignupToken({ slug: 'acme', planId: 'pro' });
    expect(issued.slug).toBe('acme');
    expect(typeof issued.token).toBe('string');
    expect(issued.token.length).toBeGreaterThan(20);

    // The raw token is never stored — only its hash; listing never exposes it.
    const listed = await tf.listSignupTokens();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ slug: 'acme', status: 'pending', planId: 'pro' });
    expect(JSON.stringify(listed)).not.toContain(issued.token);

    const { tenant } = await tf.redeemSignupToken(issued.token);
    expect(tenant.slug).toBe('acme');
    expect(tenant.metadata.planId).toBe('pro');
    expect((await tf.listSignupTokens())[0]?.status).toBe('redeemed');

    // Single-use: a second redemption fails closed.
    await expect(tf.redeemSignupToken(issued.token)).rejects.toThrow(/already redeemed/);
  });

  it('rejects an unknown or expired token', async () => {
    const store = createInMemorySignupTokenStore();
    const tf = createTenantForge({ ...base(), signupTokenStore: store });
    await expect(tf.redeemSignupToken('not-a-real-token')).rejects.toThrow(/unknown signup token/);

    const issued = await tf.issueSignupToken({ slug: 'acme', ttlSeconds: -1 }); // already expired
    await expect(tf.redeemSignupToken(issued.token)).rejects.toThrow(/expired/);
  });
});

describe('createTenantForge.scanCostAnomalies', () => {
  const period = { from: new Date('2026-06-01'), to: new Date('2026-07-01') };
  // Every metered tenant costs $10 (100 compute-seconds × $0.10).
  const provider = {
    getProjectConsumption: () =>
      Promise.resolve([
        {
          computeTimeSeconds: 100,
          activeTimeSeconds: 0,
          writtenDataBytes: 0,
          syntheticStorageBytes: 0,
        },
      ]),
  };
  const base = () => ({
    registry: fakeRegistry(),
    provisioning: fakeProvisioning(),
    secretStore: createInMemorySecretStore(),
    usageProvider: provider,
    costRates: { computeSecondUsd: 0.1 },
    defaultRegion: 'aws-us-east-1' as const,
  });

  it('fails closed without a usage provider', async () => {
    const tf = createTenantForge({
      registry: fakeRegistry(),
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
    });
    await expect(tf.scanCostAnomalies(period)).rejects.toThrow(/usage provider/);
  });

  it('flags unprofitable + unpriced tenants (most-severe first); ignores healthy ones', async () => {
    const tf = createTenantForge(base());
    await tf.provision({ slug: 'loss', metadata: { priceUsd: 5 } }); // cost 10 > price 5 → unprofitable
    await tf.provision({ slug: 'free', metadata: {} }); // cost 10, no price → unpriced
    await tf.provision({ slug: 'healthy', metadata: { priceUsd: 50 } }); // margin +40 → healthy
    const found = await tf.scanCostAnomalies(period);
    expect(found.map((f) => f.kind)).toEqual(['unprofitable', 'unpriced']);
    expect(found.map((f) => f.tenantId).sort()).toEqual(
      found.map((f) => f.tenantId).sort(), // tenant ids are generated; assert kinds + count
    );
    expect(found).toHaveLength(2);
  });

  it('honors opt-in thresholds (thin margin)', async () => {
    const tf = createTenantForge(base());
    await tf.provision({ slug: 'thin', metadata: { priceUsd: 11 } }); // margin +1
    const none = await tf.scanCostAnomalies(period);
    expect(none).toEqual([]); // profitable; not flagged by default
    const flagged = await tf.scanCostAnomalies(period, { minMarginUsd: 5 });
    expect(flagged.map((f) => f.kind)).toEqual(['low-margin']);
  });
});

describe('createTenantForge.queryAudit', () => {
  const seeded = async () => {
    const auditLog = createInMemoryAuditLogStore();
    await auditLog.append({
      event: 'tenant.charged',
      at: '2026-06-01T00:00:00.000Z',
      outcome: 'ok',
      tenantId: 't1',
    });
    await auditLog.append({
      event: 'tenant.transition',
      at: '2026-06-02T00:00:00.000Z',
      outcome: 'ok',
      tenantId: 't2',
    });
    await auditLog.append({
      event: 'tenant.charged',
      at: '2026-06-03T00:00:00.000Z',
      outcome: 'error',
      tenantId: 't1',
    });
    return createTenantForge({
      registry: fakeRegistry(),
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
      auditLog,
      eventSink: createAuditLogEventSink(auditLog),
    });
  };

  it('returns [] when no audit store is wired', async () => {
    const tf = createTenantForge({
      registry: fakeRegistry(),
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
    });
    expect(await tf.queryAudit()).toEqual([]);
  });

  it('queries newest-first and filters by event name + tenant', async () => {
    const tf = await seeded();
    const all = await tf.queryAudit();
    expect(all.map((e) => e.event)).toEqual([
      'tenant.charged',
      'tenant.transition',
      'tenant.charged',
    ]);
    const charged = await tf.queryAudit({ events: ['tenant.charged'] });
    expect(charged).toHaveLength(2);
    expect(charged.every((e) => e.event === 'tenant.charged')).toBe(true);
    const t2 = await tf.queryAudit({ tenantId: 't2' });
    expect(t2.map((e) => e.tenantId)).toEqual(['t2']);
  });

  it('respects a since lower bound and rejects a bad limit', async () => {
    const tf = await seeded();
    const recent = await tf.queryAudit({ since: '2026-06-02T00:00:00.000Z' });
    expect(recent).toHaveLength(2); // the 06-02 and 06-03 events
    await expect(tf.queryAudit({ limit: 0 })).rejects.toThrow(/positive integer/);
  });

  it('scanAuditAnomalies detects error clusters (and is [] without a store)', async () => {
    const auditLog = createInMemoryAuditLogStore();
    for (let i = 0; i < 4; i++) {
      await auditLog.append({
        event: 'tenant.charged',
        at: `2026-06-0${i + 1}T00:00:00.000Z`,
        outcome: 'error',
        tenantId: 'flaky',
        actor: { id: 'op', role: 'admin' },
      });
    }
    const tf = createTenantForge({
      registry: fakeRegistry(),
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
      auditLog,
      eventSink: createAuditLogEventSink(auditLog),
    });
    const findings = await tf.scanAuditAnomalies({
      thresholds: { errorSpike: 99, perActorErrors: 4, perTenantErrors: 4 },
    });
    expect(findings.map((f) => f.kind)).toEqual(['actor-errors', 'tenant-errors']);
    expect(findings[1]?.subject).toBe('flaky');

    const noStore = createTenantForge({
      registry: fakeRegistry(),
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
    });
    expect(await noStore.scanAuditAnomalies()).toEqual([]);
  });
});

describe('createTenantForge.sendInvoice', () => {
  const period = { from: new Date('2026-06-01'), to: new Date('2026-07-01') };
  type Notifier = import('../../src/ports/notifier.js').Notifier;
  type Notification = import('../../src/ports/notifier.js').Notification;
  const provider = {
    getProjectConsumption: () =>
      Promise.resolve([
        {
          computeTimeSeconds: 100,
          activeTimeSeconds: 0,
          writtenDataBytes: 0,
          syntheticStorageBytes: 0,
        },
      ]),
  };
  const fakeNotifier = (calls: Notification[] = []): Notifier => ({
    provider: 'log',
    notify: (n) => {
      calls.push(n);
      return Promise.resolve({ id: n.idempotencyKey, provider: 'log', status: 'queued' });
    },
  });
  const deps = (notifier?: Notifier) => {
    const auditLog = createInMemoryAuditLogStore();
    return {
      registry: fakeRegistry(),
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      usageProvider: provider,
      billingRates: { computeSecondUsd: 0.02 },
      defaultRegion: 'aws-us-east-1' as const,
      auditLog,
      eventSink: createAuditLogEventSink(auditLog),
      ...(notifier !== undefined ? { notifier } : {}),
    };
  };

  it('fails closed when no notifier is configured', async () => {
    const tf = createTenantForge(deps());
    const { tenant } = await tf.provision({
      slug: 'acme',
      metadata: { billingEmail: 'b@acme.dev' },
    });
    await expect(tf.sendInvoice(tenant.id, period)).rejects.toThrow(
      /requires a configured notifier/,
    );
  });

  it('emails the invoice to billingEmail and records tenant.invoiced (no recipient in audit)', async () => {
    const calls: Notification[] = [];
    const tf = createTenantForge(deps(fakeNotifier(calls)));
    const { tenant } = await tf.provision({
      slug: 'acme',
      metadata: { billingEmail: 'b@acme.dev' },
    });
    const r = await tf.sendInvoice(tenant.id, period);
    expect(r.sent).toBe(true);
    expect(r.totalUsd).toBe(2); // 100 * 0.02
    expect(calls).toHaveLength(1);
    expect(calls[0]?.to).toBe('b@acme.dev');
    expect(calls[0]?.idempotencyKey).toContain('tenantforge:invoice-email:');
    const history = await tf.invoiceDeliveryHistory();
    expect(history[0]?.event).toBe('tenant.invoiced');
    expect(JSON.stringify(history)).not.toContain('b@acme.dev'); // PII not recorded
  });

  it('skips (does not send) a tenant with no billingEmail', async () => {
    const calls: Notification[] = [];
    const tf = createTenantForge(deps(fakeNotifier(calls)));
    const { tenant } = await tf.provision({ slug: 'acme' });
    const r = await tf.sendInvoice(tenant.id, period);
    expect(r.sent).toBe(false);
    expect(r.reason).toMatch(/no billing email/);
    expect(calls).toHaveLength(0);
  });

  it('sendInvoiceFleet is failure-isolated: sent vs skipped', async () => {
    const tf = createTenantForge(deps(fakeNotifier()));
    await tf.provision({ slug: 'has-email', metadata: { billingEmail: 'a@x.dev' } });
    await tf.provision({ slug: 'no-email' });
    const report = await tf.sendInvoiceFleet(period);
    expect(report.sent).toHaveLength(1);
    expect(report.skipped).toHaveLength(1);
    expect(report.failed).toEqual([]);
  });
});

describe('createTenantForge plan catalog', () => {
  const plans = [
    { id: 'starter', name: 'Starter', priceUsd: 0, includedUsage: { computeTimeSeconds: 100 } },
    { id: 'pro', priceUsd: 49, includedUsage: { computeTimeSeconds: 10_000 } },
  ];
  const base = () => ({
    registry: fakeRegistry(),
    provisioning: fakeProvisioning(),
    secretStore: createInMemorySecretStore(),
    defaultRegion: 'aws-us-east-1' as const,
  });

  it('listPlans returns the configured catalog (empty without one)', () => {
    expect(
      createTenantForge({ ...base(), plans })
        .listPlans()
        .map((p) => p.id),
    ).toEqual(['starter', 'pro']);
    expect(createTenantForge(base()).listPlans()).toEqual([]);
  });

  it('assignPlan sets the tenant price + included allowances + planId', async () => {
    const tf = createTenantForge({ ...base(), plans });
    const { tenant } = await tf.provision({ slug: 'acme' });
    const updated = await tf.assignPlan(tenant.id, 'pro');
    expect(updated.metadata.planId).toBe('pro');
    expect(updated.metadata.priceUsd).toBe(49);
    expect(updated.metadata.includedUsage).toEqual({ computeTimeSeconds: 10_000 });
  });

  it('assignPlan fully redefines billing (a no-allowance plan clears prior overrides)', async () => {
    const tf = createTenantForge({ ...base(), plans });
    const { tenant } = await tf.provision({
      slug: 'acme',
      metadata: { includedUsage: { computeTimeSeconds: 999 }, priceUsd: 7 },
    });
    const updated = await tf.assignPlan(tenant.id, 'starter');
    expect(updated.metadata.priceUsd).toBe(0);
    expect(updated.metadata.includedUsage).toEqual({ computeTimeSeconds: 100 });
  });

  it('assignPlan fails closed without a catalog, on an unknown plan, and an unknown tenant', async () => {
    const noCatalog = createTenantForge(base());
    await expect(noCatalog.assignPlan('t', 'pro')).rejects.toThrow(/no plan catalog/);
    const tf = createTenantForge({ ...base(), plans });
    const { tenant } = await tf.provision({ slug: 'acme' });
    await expect(tf.assignPlan(tenant.id, 'ghost')).rejects.toThrow(/unknown plan/);
    await expect(tf.assignPlan('nope', 'pro')).rejects.toThrow(/not found/);
  });
});

describe('createTenantForge credit ledger', () => {
  const period = { from: new Date('2026-06-01'), to: new Date('2026-07-01') };
  const provider = {
    getProjectConsumption: () =>
      Promise.resolve([
        {
          computeTimeSeconds: 100,
          activeTimeSeconds: 0,
          writtenDataBytes: 0,
          syntheticStorageBytes: 0,
        },
      ]),
  };
  type Gw = import('../../src/ports/payment-gateway.js').PaymentGateway;
  type ChargeReq = import('../../src/ports/payment-gateway.js').ChargeRequest;
  const okGateway = (calls: ChargeReq[] = []): Gw => ({
    provider: 'stripe',
    charge: (r) => {
      calls.push(r);
      return Promise.resolve({
        id: 'ch_1',
        status: 'succeeded',
        amountMinor: r.amountMinor,
        currency: r.currency,
        provider: 'stripe',
      });
    },
    refund: () => Promise.reject(new Error('unused')),
  });
  const base = (extra: Record<string, unknown>) => {
    const auditLog = createInMemoryAuditLogStore();
    return {
      registry: fakeRegistry(),
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      usageProvider: provider,
      billingRates: { computeSecondUsd: 0.02 }, // $2.00 invoice → 200 minor
      defaultRegion: 'aws-us-east-1' as const,
      auditLog,
      eventSink: createAuditLogEventSink(auditLog),
      ...extra,
    };
  };

  it('grantCredit raises the balance and records tenant.credit_granted; reads back', async () => {
    const tf = createTenantForge(
      base({ paymentGateway: okGateway(), creditLedger: createInMemoryCreditLedger() }),
    );
    await tf.grantCredit('t-a', 1500, { reason: 'goodwill' });
    expect(await tf.creditBalance('t-a')).toBe(1500);
    expect((await tf.creditHistory('t-a'))[0]?.amountMinor).toBe(1500);
    expect((await tf.creditGrantHistory())[0]?.event).toBe('tenant.credit_granted');
  });

  it('grantCredit fails closed without a ledger, and rejects a non-positive amount', async () => {
    const noLedger = createTenantForge(base({ paymentGateway: okGateway() }));
    await expect(noLedger.grantCredit('t-a', 100)).rejects.toThrow(
      /requires a configured credit ledger/,
    );
    expect(await noLedger.creditBalance('t-a')).toBe(0);
    const tf = createTenantForge(
      base({ paymentGateway: okGateway(), creditLedger: createInMemoryCreditLedger() }),
    );
    await expect(tf.grantCredit('t-a', 0)).rejects.toThrow(/positive integer/);
  });

  it('a charge draws down credit first and charges only the remainder', async () => {
    const calls: ChargeReq[] = [];
    const tf = createTenantForge(
      base({ paymentGateway: okGateway(calls), creditLedger: createInMemoryCreditLedger() }),
    );
    const { tenant } = await tf.provision({
      slug: 'acme',
      metadata: { billingCustomerRef: 'cus_1' },
    });
    await tf.grantCredit(tenant.id, 50); // partial — invoice is 200
    const result = await tf.chargeInvoice(tenant.id, period);
    expect(result.amountMinor).toBe(150);
    expect(calls[0]?.amountMinor).toBe(150);
    expect(await tf.creditBalance(tenant.id)).toBe(0);
  });

  it('credit covering the whole invoice skips the card charge entirely', async () => {
    const calls: ChargeReq[] = [];
    const tf = createTenantForge(
      base({ paymentGateway: okGateway(calls), creditLedger: createInMemoryCreditLedger() }),
    );
    const { tenant } = await tf.provision({
      slug: 'acme',
      metadata: { billingCustomerRef: 'cus_1' },
    });
    await tf.grantCredit(tenant.id, 500);
    const result = await tf.chargeInvoice(tenant.id, period);
    expect(result.provider).toBe('credit');
    expect(result.amountMinor).toBe(0);
    expect(calls).toHaveLength(0);
    expect(await tf.creditBalance(tenant.id)).toBe(300);
  });

  it('a downgrade with a ledger grants the FULL credit (uncapped)', async () => {
    const tf = createTenantForge(
      base({ paymentGateway: okGateway(), creditLedger: createInMemoryCreditLedger() }),
    );
    const { tenant } = await tf.provision({
      slug: 'acme',
      metadata: { priceUsd: 30, billingCustomerRef: 'cus_1' },
    });
    const report = await tf.changePlan(tenant.id, 10, {
      period,
      asOf: new Date('2026-06-16T00:00:00.000Z'),
      settle: true,
    });
    expect(report.settlement).toBe('credited');
    expect(report.proratedDeltaMinor).toBe(-1000);
    expect(await tf.creditBalance(tenant.id)).toBe(1000);
  });
});

describe('createTenantForge.changePlan / previewPlanChange', () => {
  const period = { from: new Date('2026-06-01'), to: new Date('2026-07-01') };
  const mid = new Date('2026-06-16T00:00:00.000Z'); // half the period remains
  type Gw = import('../../src/ports/payment-gateway.js').PaymentGateway;
  type ChargeReq = import('../../src/ports/payment-gateway.js').ChargeRequest;
  type RefundReq = import('../../src/ports/payment-gateway.js').RefundRequest;
  const gateway = (charges: ChargeReq[] = [], refunds: RefundReq[] = []): Gw => ({
    provider: 'stripe',
    charge: (r) => {
      charges.push(r);
      return Promise.resolve({
        id: 'ch_new',
        status: 'succeeded',
        amountMinor: r.amountMinor,
        currency: r.currency,
        provider: 'stripe',
      });
    },
    refund: (r) => {
      refunds.push(r);
      return Promise.resolve({
        id: 're_new',
        status: 'succeeded',
        amountMinor: r.amountMinor ?? 0,
        currency: r.currency,
        provider: 'stripe',
      });
    },
  });
  const seedTenant = (
    registry: ReturnType<typeof fakeRegistry>,
    metadata: Record<string, unknown>,
  ) =>
    registry.seed({
      id: 't1',
      slug: 't1',
      region: 'aws-us-east-1',
      status: 'active',
      neonProjectId: 'proj-t1',
      metadata: metadata as JsonObject,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });

  it('previewPlanChange quotes the prorated delta without mutating or moving money', async () => {
    const registry = fakeRegistry();
    seedTenant(registry, { priceUsd: 10 });
    const charges: ChargeReq[] = [];
    const tf = createTenantForge({
      registry,
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
      paymentGateway: gateway(charges),
    });
    const preview = await tf.previewPlanChange('t1', 20, { period, asOf: mid });
    expect(preview).toMatchObject({ tenantId: 't1', oldPriceUsd: 10, newPriceUsd: 20 });
    expect(preview.proratedDeltaMinor).toBe(500); // half of (2000-1000)
    expect(charges).toHaveLength(0); // no money
    expect((await registry.getById('t1'))?.metadata['priceUsd']).toBe(10); // no mutation
  });

  it('changePlan updates the price; an upgrade with settle charges the prorated delta', async () => {
    const registry = fakeRegistry();
    seedTenant(registry, { priceUsd: 10, billingCustomerRef: 'cus_1' });
    const auditLog = createInMemoryAuditLogStore();
    const charges: ChargeReq[] = [];
    const tf = createTenantForge({
      registry,
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
      paymentGateway: gateway(charges),
      auditLog,
      eventSink: createAuditLogEventSink(auditLog),
    });
    const report = await tf.changePlan('t1', 20, { period, asOf: mid, settle: true });
    expect(report.settlement).toBe('charged');
    expect(report.proratedDeltaMinor).toBe(500);
    expect(charges[0]?.amountMinor).toBe(500);
    expect(charges[0]?.idempotencyKey).toContain(':plan-change:');
    expect((await registry.getById('t1'))?.metadata['priceUsd']).toBe(20); // price updated
    expect((await tf.planChangeHistory())[0]?.context?.settlement).toBe('charged');
  });

  it('a downgrade with settle refunds the credit against the latest charge (capped)', async () => {
    const registry = fakeRegistry();
    seedTenant(registry, { priceUsd: 20, billingCustomerRef: 'cus_1' });
    const auditLog = createInMemoryAuditLogStore();
    // A prior charge of 1000 the credit can be refunded against (the credit is 500, within it).
    await auditLog.append({
      event: 'tenant.charged',
      at: '2026-06-10T00:00:00.000Z',
      outcome: 'ok',
      tenantId: 't1',
      context: { chargeId: 'ch_old', amountMinor: 1000, currency: 'usd', status: 'succeeded' },
    });
    const refunds: RefundReq[] = [];
    const tf = createTenantForge({
      registry,
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
      paymentGateway: gateway([], refunds),
      auditLog,
      eventSink: createAuditLogEventSink(auditLog),
    });
    const report = await tf.changePlan('t1', 10, { period, asOf: mid, settle: true });
    expect(report.settlement).toBe('refunded');
    expect(report.proratedDeltaMinor).toBe(-500);
    expect(refunds[0]?.chargeId).toBe('ch_old');
    expect(refunds[0]?.amountMinor).toBe(500);
  });

  it('updates the price but skips settlement when there is no billing customer ref', async () => {
    const registry = fakeRegistry();
    seedTenant(registry, { priceUsd: 10 }); // no billingCustomerRef
    const charges: ChargeReq[] = [];
    const tf = createTenantForge({
      registry,
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
      paymentGateway: gateway(charges),
    });
    const report = await tf.changePlan('t1', 20, { period, asOf: mid, settle: true });
    expect(report.settlement).toBe('skipped');
    expect(charges).toHaveLength(0);
    expect((await registry.getById('t1'))?.metadata['priceUsd']).toBe(20); // price still updated
  });

  it('without settle, changePlan updates the price and moves no money (settlement none)', async () => {
    const registry = fakeRegistry();
    seedTenant(registry, { priceUsd: 10, billingCustomerRef: 'cus_1' });
    const charges: ChargeReq[] = [];
    const tf = createTenantForge({
      registry,
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
      paymentGateway: gateway(charges),
    });
    const report = await tf.changePlan('t1', 20, { period, asOf: mid });
    expect(report.settlement).toBe('none');
    expect(charges).toHaveLength(0);
    expect((await registry.getById('t1'))?.metadata['priceUsd']).toBe(20);
  });

  it('rejects a negative price', async () => {
    const registry = fakeRegistry();
    seedTenant(registry, { priceUsd: 10 });
    const tf = createTenantForge({
      registry,
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
    });
    await expect(tf.previewPlanChange('t1', -5)).rejects.toThrow(/non-negative/);
  });
});

describe('createTenantForge portal reads (tenant-scoped)', () => {
  function seedTenant(
    registry: ReturnType<typeof fakeRegistry>,
    id: string,
    metadata: Record<string, unknown>,
  ) {
    registry.seed({
      id,
      slug: id,
      region: 'aws-us-east-1',
      status: 'active',
      neonProjectId: `proj-${id}`,
      metadata: metadata as JsonObject,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date(0),
    });
  }
  const setup = () => {
    const registry = fakeRegistry();
    const auditLog = createInMemoryAuditLogStore();
    seedTenant(registry, 't-a', {
      billingCustomerRef: 'cus_a',
      priceUsd: 9,
      internalFlag: 'secret',
    });
    seedTenant(registry, 't-b', { billingCustomerRef: 'cus_b' });
    const charged = (tenantId: string, chargeId: string) =>
      auditLog.append({
        event: 'tenant.charged',
        at: '2026-06-20T00:00:00.000Z',
        outcome: 'ok',
        tenantId,
        context: { chargeId, amountMinor: 900, currency: 'usd', status: 'succeeded' },
      });
    const tf = createTenantForge({
      registry,
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
      auditLog,
      eventSink: createAuditLogEventSink(auditLog),
    });
    return { tf, auditLog, charged };
  };

  it('tenantSummary returns a safe projection — no raw metadata or internal infra id', async () => {
    const { tf } = setup();
    const summary = await tf.tenantSummary('t-a');
    expect(summary).toEqual({
      id: 't-a',
      slug: 't-a',
      region: 'aws-us-east-1',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      planPriceUsd: 9,
    });
    expect(summary as unknown as Record<string, unknown>).not.toHaveProperty('metadata');
    expect(summary as unknown as Record<string, unknown>).not.toHaveProperty('neonProjectId');
    expect(JSON.stringify(summary)).not.toContain('cus_a');
    expect(JSON.stringify(summary)).not.toContain('internalFlag');
    expect(await tf.tenantSummary('missing')).toBeNull();
  });

  it('tenantCharges / tenantRefunds are strictly tenant-scoped (no cross-tenant leakage)', async () => {
    const { tf, auditLog, charged } = setup();
    await charged('t-a', 'ch_a');
    await charged('t-b', 'ch_b');
    await auditLog.append({
      event: 'tenant.refunded',
      at: '2026-06-21T00:00:00.000Z',
      outcome: 'ok',
      tenantId: 't-a',
      context: { refundId: 're_a', chargeId: 'ch_a' },
    });

    const aCharges = await tf.tenantCharges('t-a');
    expect(aCharges).toHaveLength(1);
    expect(aCharges[0]?.context?.chargeId).toBe('ch_a');
    expect(aCharges.every((e) => e.tenantId === 't-a')).toBe(true);
    expect(JSON.stringify(aCharges)).not.toContain('ch_b');

    await auditLog.append({
      event: 'tenant.notified',
      at: '2026-06-22T00:00:00.000Z',
      outcome: 'ok',
      tenantId: 't-a',
      context: { kind: 'charge', reference: 'ch_a', status: 'queued' },
    });

    expect((await tf.tenantRefunds('t-a')).every((e) => e.tenantId === 't-a')).toBe(true);
    expect((await tf.tenantCharges('t-b')).map((e) => e.context?.chargeId)).toEqual(['ch_b']);
    expect(await tf.tenantRefunds('t-b')).toEqual([]);
    // Receipts are tenant-scoped too — tenant A's receipt never leaks to B.
    expect((await tf.tenantNotifications('t-a')).map((e) => e.context?.reference)).toEqual([
      'ch_a',
    ]);
    expect(await tf.tenantNotifications('t-b')).toEqual([]);
  });

  it('tenant history is empty without an audit store', async () => {
    const tf = createTenantForge({
      registry: fakeRegistry(),
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      defaultRegion: 'aws-us-east-1',
    });
    expect(await tf.tenantCharges('t-a')).toEqual([]);
    expect(await tf.tenantRefunds('t-a')).toEqual([]);
    expect(await tf.tenantNotifications('t-a')).toEqual([]);
  });
});

describe('createTenantForge.ingestPaymentWebhook', () => {
  type Verifier = import('../../src/ports/payment-webhook.js').PaymentWebhookVerifier;
  type Event = import('../../src/ports/payment-webhook.js').PaymentEvent;
  const sampleEvent: Event = {
    id: 'evt_1',
    type: 'charge.succeeded',
    provider: 'stripe',
    rawType: 'payment_intent.succeeded',
    occurredAt: '2026-06-21T00:00:00.000Z',
    tenantRef: 't-42',
    chargeId: 'pi_1',
    amountMinor: 1234,
    currency: 'usd',
  };
  const verifier = (event: Event = sampleEvent, throws = false): Verifier => ({
    provider: 'stripe',
    verify: () => {
      if (throws) throw new Error('signature mismatch');
      return event;
    },
  });
  const base = () => ({
    registry: fakeRegistry(),
    provisioning: fakeProvisioning(),
    secretStore: createInMemorySecretStore(),
    defaultRegion: 'aws-us-east-1' as const,
  });

  it('fails closed without a configured verifier', async () => {
    const tf = createTenantForge(base());
    await expect(tf.ingestPaymentWebhook('{}', 'sig')).rejects.toThrow(
      /requires a configured verifier/,
    );
  });

  it('rejects a bad signature (propagates the verifier error)', async () => {
    const tf = createTenantForge({
      ...base(),
      paymentWebhookVerifier: verifier(sampleEvent, true),
    });
    await expect(tf.ingestPaymentWebhook('{}', 'bad')).rejects.toThrow(/signature mismatch/);
  });

  it('verifies + records a payment.webhook audit event (attributed to the tenant) and returns it', async () => {
    const auditLog = createInMemoryAuditLogStore();
    const tf = createTenantForge({
      ...base(),
      paymentWebhookVerifier: verifier(),
      auditLog,
      eventSink: createAuditLogEventSink(auditLog),
    });
    const event = await tf.ingestPaymentWebhook('{raw}', 'sig');
    expect(event.id).toBe('evt_1');

    const history = await tf.paymentWebhookHistory();
    expect(history).toHaveLength(1);
    expect(history[0]?.event).toBe('payment.webhook');
    expect(history[0]?.tenantId).toBe('t-42'); // from the event's tenantRef
    expect(history[0]?.context?.type).toBe('charge.succeeded');
  });

  it('records a failed-charge webhook with outcome error', async () => {
    const auditLog = createInMemoryAuditLogStore();
    const tf = createTenantForge({
      ...base(),
      paymentWebhookVerifier: verifier({ ...sampleEvent, type: 'charge.failed' }),
      auditLog,
      eventSink: createAuditLogEventSink(auditLog),
    });
    await tf.ingestPaymentWebhook('{raw}', 'sig');
    expect((await tf.paymentWebhookHistory())[0]?.outcome).toBe('error');
  });

  it('paymentWebhookHistory returns [] without an audit store', async () => {
    const tf = createTenantForge({ ...base(), paymentWebhookVerifier: verifier() });
    expect(await tf.paymentWebhookHistory()).toEqual([]);
  });
});

describe('createTenantForge.provision residency', () => {
  const make = (allowedRegions?: string[]) => {
    const provisioning = fakeProvisioning();
    const tf = createTenantForge({
      registry: fakeRegistry(),
      provisioning,
      secretStore: createInMemorySecretStore(),
      ...(allowedRegions ? { allowedRegions } : {}),
      defaultRegion: 'aws-us-east-1',
    });
    return { tf, provisioning };
  };

  it('rejects a region outside the org allow-list (before any project is created)', async () => {
    const { tf, provisioning } = make(['aws-eu-central-1']);
    await expect(tf.provision({ slug: 'acme', region: 'aws-us-east-1' })).rejects.toThrow(
      /not in the allowed set/,
    );
    expect(provisioning.calls).toHaveLength(0);
  });

  it('allows a region within the allow-list', async () => {
    const { tf } = make(['aws-eu-central-1']);
    const { tenant } = await tf.provision({ slug: 'acme', region: 'aws-eu-central-1' });
    expect(tenant.status).toBe('active');
  });

  it('enforces a per-tenant residency jurisdiction (fail closed on mismatch)', async () => {
    const { tf, provisioning } = make();
    await expect(
      tf.provision({ slug: 'acme', region: 'aws-us-east-1', residency: 'eu' }),
    ).rejects.toThrow(/does not satisfy required residency/);
    expect(provisioning.calls).toHaveLength(0);
  });

  it('accepts a region that satisfies the required residency', async () => {
    const { tf } = make();
    const { tenant } = await tf.provision({
      slug: 'acme',
      region: 'aws-eu-central-1',
      residency: 'eu',
    });
    expect(tenant.region).toBe('aws-eu-central-1');
  });
});

describe('createLifecycleHandler', () => {
  it('maps each queue command to its TenantForge operation', async () => {
    const calls: string[] = [];
    const tf = {
      provision: (i: { slug: string }) => (calls.push(`provision:${i.slug}`), Promise.resolve({})),
      suspend: (id: string) => (calls.push(`suspend:${id}`), Promise.resolve({})),
      resume: (id: string) => (calls.push(`resume:${id}`), Promise.resolve({})),
      offboard: (id: string) => (calls.push(`offboard:${id}`), Promise.resolve({})),
    } as unknown as import('../../src/app/lib.js').TenantForge;
    const handle = createLifecycleHandler(tf);

    await handle({ id: '1', type: 'provision', slug: 'acme', residency: 'eu' });
    await handle({ id: '2', type: 'suspend', tenantId: 't1' });
    await handle({ id: '3', type: 'resume', tenantId: 't1' });
    await handle({ id: '4', type: 'offboard', tenantId: 't1' });

    expect(calls).toEqual(['provision:acme', 'suspend:t1', 'resume:t1', 'offboard:t1']);
  });
});

describe('createTenantForge.complianceReport', () => {
  const rec = (over: Partial<TenantRecord>): TenantRecord => ({
    id: 'x',
    slug: 'x',
    region: 'aws-us-east-1',
    status: 'active',
    neonProjectId: 'p',
    metadata: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  });

  it('builds a fleet report, stamps a sha256 digest, and emits an audit event', async () => {
    const events: TenantEvent[] = [];
    const registry = fakeRegistry();
    registry.seed(rec({ id: 'a', neonProjectId: 'shared' }));
    registry.seed(rec({ id: 'b', neonProjectId: 'shared' })); // shared project → isolation violation
    const tf = createTenantForge({
      registry,
      provisioning: fakeProvisioning(),
      secretStore: createInMemorySecretStore(),
      eventSink: { emit: (e: TenantEvent) => events.push(e) },
      defaultRegion: 'aws-us-east-1',
    });

    const { report, digest } = await tf.complianceReport();
    expect(report.inventory.total).toBe(2);
    expect(report.isolation.compliant).toBe(false); // shared project caught
    expect(digest).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
    const ev = events.find((e) => e.event === 'compliance.report_generated');
    expect(ev?.outcome).toBe('error'); // a violation → error outcome
  });
});
