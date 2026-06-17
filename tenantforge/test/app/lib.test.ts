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
import { createTenantForge } from '../../src/app/lib.js';

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
