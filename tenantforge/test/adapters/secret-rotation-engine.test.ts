import { describe, expect, it, vi } from 'vitest';
import type { TenantRecord } from '../../src/core/domain.js';
import type { TenantEvent } from '../../src/core/observability.js';
import type { ProvisioningProvider } from '../../src/ports/provisioning-provider.js';
import type { SecretStore } from '../../src/ports/secret-store.js';
import type { TenantRegistry } from '../../src/ports/tenant-registry.js';
import { createSecretRotationEngine } from '../../src/adapters/secret-rotation-engine.js';

function tenant(overrides: Partial<TenantRecord> = {}): TenantRecord {
  return {
    id: 't1',
    slug: 'acme',
    region: 'aws-us-east-1',
    status: 'active',
    neonProjectId: 'proj-1',
    metadata: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function makeEnv(records: TenantRecord[]) {
  const byId = new Map(records.map((r) => [r.id, r]));
  const secrets = new Map<string, string>();
  const events: TenantEvent[] = [];
  let counter = 0;

  const registry = {
    getById: (id: string) => Promise.resolve(byId.get(id) ?? null),
    list: (opts?: { status?: string }) =>
      Promise.resolve([...byId.values()].filter((r) => !opts?.status || r.status === opts.status)),
  } as unknown as TenantRegistry;

  const provisioning = {
    rotateTenantCredential: (projectId: string) => {
      counter += 1;
      return Promise.resolve({ connectionUri: `postgres://new-${counter}@host/${projectId}` });
    },
  } as unknown as ProvisioningProvider;

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

  return { byId, secrets, events, registry, provisioning, secretStore };
}

const fixedNow = (): Date => new Date('2026-06-18T00:00:00.000Z');

describe('createSecretRotationEngine.rotate', () => {
  it('mints a new credential, stores it, invalidates, and audits', async () => {
    const env = makeEnv([tenant()]);
    const onRotated = vi.fn();
    const engine = createSecretRotationEngine({
      registry: env.registry,
      provisioning: env.provisioning,
      secretStore: env.secretStore,
      onRotated,
      emit: (e) => env.events.push(e),
      now: fixedNow,
    });
    const result = await engine.rotate('t1');

    expect(result).toEqual({ tenantId: 't1', rotated: true });
    expect(env.secrets.get('t1')).toBe('postgres://new-1@host/proj-1');
    expect(onRotated).toHaveBeenCalledWith('t1');
    expect(env.events[0]).toEqual({
      event: 'tenant.secret_rotated',
      at: '2026-06-18T00:00:00.000Z',
      outcome: 'ok',
      tenantId: 't1',
    });
  });

  it('throws when the tenant is not found', async () => {
    const env = makeEnv([]);
    const engine = createSecretRotationEngine({
      registry: env.registry,
      provisioning: env.provisioning,
      secretStore: env.secretStore,
    });
    await expect(engine.rotate('ghost')).rejects.toThrow(/tenant not found: ghost/);
  });

  it('throws when the tenant is not active/provisioned', async () => {
    const env = makeEnv([tenant({ status: 'suspended' })]);
    const engine = createSecretRotationEngine({
      registry: env.registry,
      provisioning: env.provisioning,
      secretStore: env.secretStore,
    });
    await expect(engine.rotate('t1')).rejects.toThrow(/must be active and provisioned/);
  });
});

describe('createSecretRotationEngine.rotateAll', () => {
  it('rotates every active tenant and reports the sweep (failure-isolated)', async () => {
    const env = makeEnv([
      tenant({ id: 't1' }),
      tenant({ id: 't2', neonProjectId: null }), // active but unprovisioned → rotate() throws → isolated
      tenant({ id: 't3' }),
      tenant({ id: 't4', status: 'suspended' }), // not active → excluded from the sweep
    ]);
    const engine = createSecretRotationEngine({
      registry: env.registry,
      provisioning: env.provisioning,
      secretStore: env.secretStore,
      emit: (e) => env.events.push(e),
      now: fixedNow,
    });
    const report = await engine.rotateAll();

    expect(report.scanned).toBe(3); // t1, t2, t3 are active; t4 excluded
    expect(report.rotated).toEqual(['t1', 't3']);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]!.tenantId).toBe('t2');
    expect(env.events.at(-1)).toMatchObject({
      event: 'tenant.secret_rotation_sweep',
      outcome: 'error',
    });
  });

  it('stringifies a non-Error rejection in the sweep failure list', async () => {
    const env = makeEnv([tenant({ id: 't1' })]);
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- testing a non-Error throw
    env.provisioning.rotateTenantCredential = () => Promise.reject('neon exploded');
    const engine = createSecretRotationEngine({
      registry: env.registry,
      provisioning: env.provisioning,
      secretStore: env.secretStore,
    });
    const report = await engine.rotateAll();
    expect(report.failed).toEqual([{ tenantId: 't1', error: 'neon exploded' }]);
  });

  it('honors a scan limit and reports ok when all succeed (no emit / default clock)', async () => {
    const env = makeEnv([tenant({ id: 't1' }), tenant({ id: 't2' })]);
    const engine = createSecretRotationEngine({
      registry: env.registry,
      provisioning: env.provisioning,
      secretStore: env.secretStore,
    });
    const report = await engine.rotateAll({ limit: 10 });
    expect(report.rotated).toEqual(['t1', 't2']);
    expect(report.failed).toEqual([]);
  });
});
