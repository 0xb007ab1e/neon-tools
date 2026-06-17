import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonObject, TenantRecord, TenantStatus } from '../../src/core/domain.js';
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
  let seq = 0;
  const clone = (r: TenantRecord): TenantRecord => ({ ...r, metadata: { ...r.metadata } });
  return {
    seed(record) {
      byId.set(record.id, record);
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

  it('offboards: exports, then deletes the project, then marks deleted', async () => {
    const tf = createTenantForge({
      registry,
      provisioning,
      secretStore,
      defaultRegion: 'aws-us-east-1',
      exporter,
    });
    const { tenant } = await tf.provision({ slug: 'acme' });
    const outcome = await tf.offboard(tenant.id);
    expect(outcome.tenant.status).toBe('deleted');
    expect(outcome.export?.location).toBe('s3://exports/t');
    expect(provisioning.deletes).toEqual(['proj-1']);
  });

  it('fails closed: no exporter and export not skipped → throws BEFORE deleting', async () => {
    const tf = createTenantForge({
      registry,
      provisioning,
      secretStore,
      defaultRegion: 'aws-us-east-1',
    });
    const { tenant } = await tf.provision({ slug: 'acme' });
    await expect(tf.offboard(tenant.id)).rejects.toThrow(/no exporter configured/);
    expect(provisioning.deletes).toEqual([]); // irreversible delete never ran
  });

  it('requires a reason when export is skipped', async () => {
    const tf = createTenantForge({
      registry,
      provisioning,
      secretStore,
      defaultRegion: 'aws-us-east-1',
    });
    const { tenant } = await tf.provision({ slug: 'acme' });
    await expect(tf.offboard(tenant.id, { skipExport: true })).rejects.toThrow(/requires a reason/);
  });

  it('offboards with export skipped when a reason is given', async () => {
    const tf = createTenantForge({
      registry,
      provisioning,
      secretStore,
      defaultRegion: 'aws-us-east-1',
    });
    const { tenant } = await tf.provision({ slug: 'acme' });
    const outcome = await tf.offboard(tenant.id, { skipExport: true, reason: 'never activated' });
    expect(outcome.tenant.status).toBe('deleted');
    expect(outcome.export).toBeNull();
    expect(provisioning.deletes).toEqual(['proj-1']);
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

  it('offboard crypto-shreds the connection secret', async () => {
    const tf = make();
    const { tenant } = await tf.provision({ slug: 'acme' });
    await tf.offboard(tenant.id, { skipExport: true, reason: 'test' });
    expect(await secretStore.get(tenant.id)).toBeNull();
  });
});
