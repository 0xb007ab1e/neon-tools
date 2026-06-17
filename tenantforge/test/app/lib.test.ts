import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonObject, TenantRecord, TenantStatus } from '../../src/core/domain.js';
import type { NewTenant, TenantRegistry } from '../../src/ports/tenant-registry.js';
import type {
  ProvisioningProvider,
  ProvisionRequest,
} from '../../src/ports/provisioning-provider.js';
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

/** Provisioning provider fake that records calls. */
function fakeProvisioning(): ProvisioningProvider & { calls: ProvisionRequest[] } {
  const calls: ProvisionRequest[] = [];
  return {
    calls,
    createTenantProject(request) {
      calls.push(request);
      return Promise.resolve({
        neonProjectId: `proj-${calls.length}`,
        connectionUri: 'postgresql://secret@host/db',
      });
    },
    deleteTenantProject: () => Promise.resolve(),
  };
}

describe('createTenantForge.provision', () => {
  let registry: ReturnType<typeof fakeRegistry>;
  let provisioning: ReturnType<typeof fakeProvisioning>;

  beforeEach(() => {
    registry = fakeRegistry();
    provisioning = fakeProvisioning();
  });

  const make = () => createTenantForge({ registry, provisioning, defaultRegion: 'aws-us-east-1' });

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

describe('createTenantForge queries', () => {
  it('lists and gets tenants', async () => {
    const registry = fakeRegistry();
    const provisioning = fakeProvisioning();
    const tf = createTenantForge({ registry, provisioning, defaultRegion: 'aws-us-east-1' });
    const { tenant } = await tf.provision({ slug: 'acme' });
    expect(await tf.getTenant(tenant.id)).not.toBeNull();
    expect(await tf.getTenant('missing')).toBeNull();
    expect(await tf.listTenants()).toHaveLength(1);
    expect(await tf.listTenants({ status: 'suspended' })).toHaveLength(0);
  });
});
