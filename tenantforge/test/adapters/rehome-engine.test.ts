import { describe, expect, it } from 'vitest';
import type { TenantRecord } from '../../src/core/domain.js';
import type { TenantEvent } from '../../src/core/observability.js';
import type { ProvisioningProvider } from '../../src/ports/provisioning-provider.js';
import type { SecretStore } from '../../src/ports/secret-store.js';
import type { TenantDataMover } from '../../src/ports/tenant-data-mover.js';
import type { TenantRegistry } from '../../src/ports/tenant-registry.js';
import { createRehomeEngine, type RehomeEngineDeps } from '../../src/adapters/rehome-engine.js';

function tenant(overrides: Partial<TenantRecord> = {}): TenantRecord {
  return {
    id: 't1',
    slug: 'acme',
    region: 'aws-us-east-1',
    status: 'active',
    neonProjectId: 'proj-old',
    metadata: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function makeEnv(seed: TenantRecord) {
  const record = { ...seed };
  const secrets = new Map<string, string>([[seed.id, 'postgres://old@host/db']]);
  const events: TenantEvent[] = [];
  const calls = { created: [] as unknown[], deleted: [] as string[], moved: [] as unknown[] };

  const registry = {
    getById: (id: string) => Promise.resolve(id === record.id ? { ...record } : null),
    relocate: (id: string, region: string, neonProjectId: string) => {
      if (id === record.id) {
        record.region = region;
        record.neonProjectId = neonProjectId;
      }
      return Promise.resolve();
    },
  } as unknown as TenantRegistry;

  const provisioning: ProvisioningProvider = {
    createTenantProject: (req: { slug: string; region: string }) => {
      calls.created.push(req);
      return Promise.resolve({
        neonProjectId: 'proj-new',
        connectionUri: 'postgres://new@host/db',
      });
    },
    deleteTenantProject: (id: string) => {
      calls.deleted.push(id);
      return Promise.resolve();
    },
  };

  const secretStore: SecretStore = {
    get: (k: string) => Promise.resolve(secrets.get(k) ?? null),
    set: (k: string, v: string) => {
      secrets.set(k, v);
      return Promise.resolve();
    },
    delete: (k: string) => {
      secrets.delete(k);
      return Promise.resolve();
    },
  };

  const dataMover: TenantDataMover = {
    move: (input) => {
      calls.moved.push(input);
      return Promise.resolve();
    },
  };

  return { record, secrets, events, calls, registry, provisioning, secretStore, dataMover };
}

const deps = (
  env: ReturnType<typeof makeEnv>,
  extra: Partial<RehomeEngineDeps> = {},
): RehomeEngineDeps => ({
  registry: env.registry,
  provisioning: env.provisioning,
  secretStore: env.secretStore,
  dataMover: env.dataMover,
  emit: (e) => env.events.push(e),
  now: () => new Date('2026-06-18T00:00:00.000Z'),
  ...extra,
});

describe('createRehomeEngine.rehome', () => {
  it('provisions new → copies → swaps registry+secret → deletes old (happy path)', async () => {
    const env = makeEnv(tenant());
    const result = await createRehomeEngine(deps(env)).rehome('t1', { region: 'aws-eu-central-1' });

    expect(env.calls.created).toEqual([{ slug: 'acme', region: 'aws-eu-central-1' }]);
    expect(env.calls.moved).toEqual([
      { from: 'postgres://old@host/db', to: 'postgres://new@host/db' },
    ]);
    expect(env.record.region).toBe('aws-eu-central-1');
    expect(env.record.neonProjectId).toBe('proj-new');
    expect(env.secrets.get('t1')).toBe('postgres://new@host/db');
    expect(env.calls.deleted).toEqual(['proj-old']); // old decommissioned last
    expect(result).toEqual({
      tenantId: 't1',
      fromRegion: 'aws-us-east-1',
      toRegion: 'aws-eu-central-1',
      oldProjectDeleted: true,
    });
    expect(env.events[0]).toMatchObject({ event: 'tenant.rehomed', outcome: 'ok' });
  });

  it('rolls back the new project and keeps the source when the data copy fails', async () => {
    const env = makeEnv(tenant());
    env.dataMover.move = () => Promise.reject(new Error('copy failed'));
    await expect(
      createRehomeEngine(deps(env)).rehome('t1', { region: 'aws-eu-central-1' }),
    ).rejects.toThrow(/copy failed/);
    // The freshly created target is deleted; the source project + secret are untouched.
    expect(env.calls.deleted).toEqual(['proj-new']);
    expect(env.record.neonProjectId).toBe('proj-old');
    expect(env.secrets.get('t1')).toBe('postgres://old@host/db');
  });

  it('reports oldProjectDeleted=false (best-effort) when deleting the old project fails', async () => {
    const env = makeEnv(tenant());
    const realDelete = env.provisioning.deleteTenantProject.bind(env.provisioning);
    env.provisioning.deleteTenantProject = (id: string) => {
      env.calls.deleted.push(id);
      return id === 'proj-old' ? Promise.reject(new Error('neon down')) : realDelete(id);
    };
    const result = await createRehomeEngine(deps(env)).rehome('t1', { region: 'aws-eu-central-1' });
    expect(result.oldProjectDeleted).toBe(false);
    expect(env.record.neonProjectId).toBe('proj-new'); // re-home still succeeded
    expect(env.events[0]).toMatchObject({ outcome: 'error' });
  });

  it('throws when the tenant is not found', async () => {
    const env = makeEnv(tenant());
    await expect(
      createRehomeEngine(deps(env)).rehome('ghost', { region: 'aws-eu-west-1' }),
    ).rejects.toThrow(/tenant not found: ghost/);
  });

  it('throws when the tenant is not active', async () => {
    const env = makeEnv(tenant({ status: 'suspended' }));
    await expect(
      createRehomeEngine(deps(env)).rehome('t1', { region: 'aws-eu-west-1' }),
    ).rejects.toThrow(/must be active and provisioned/);
  });

  it('enforces residency on the target (rejects a non-compliant region)', async () => {
    const env = makeEnv(tenant());
    await expect(
      createRehomeEngine(deps(env)).rehome('t1', { region: 'aws-us-west-2', residency: 'eu' }),
    ).rejects.toThrow(/does not satisfy required residency "eu"/);
    expect(env.calls.created).toEqual([]); // failed before provisioning anything
  });

  it('rejects re-homing to the current region', async () => {
    const env = makeEnv(tenant());
    await expect(
      createRehomeEngine(deps(env)).rehome('t1', { region: 'aws-us-east-1' }),
    ).rejects.toThrow(/already in region aws-us-east-1/);
  });

  it('throws when there is no connection secret to copy from', async () => {
    const env = makeEnv(tenant());
    env.secrets.delete('t1');
    await expect(
      createRehomeEngine(deps(env)).rehome('t1', { region: 'aws-eu-west-1' }),
    ).rejects.toThrow(/no connection secret/);
  });

  it('honors the allow-list and works without an emit sink + default clock', async () => {
    const env = makeEnv(tenant());
    const engine = createRehomeEngine({
      registry: env.registry,
      provisioning: env.provisioning,
      secretStore: env.secretStore,
      dataMover: env.dataMover,
      allowedRegions: ['aws-eu-central-1'],
    });
    const result = await engine.rehome('t1', { region: 'aws-eu-central-1' });
    expect(result.toRegion).toBe('aws-eu-central-1');
  });

  it('rejects a target outside the allow-list', async () => {
    const env = makeEnv(tenant());
    await expect(
      createRehomeEngine(deps(env, { allowedRegions: ['aws-us-east-1'] })).rehome('t1', {
        region: 'aws-eu-central-1',
      }),
    ).rejects.toThrow(/not in the allowed set/);
  });
});
