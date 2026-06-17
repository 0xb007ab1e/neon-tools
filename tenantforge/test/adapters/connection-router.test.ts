import { describe, expect, it } from 'vitest';
import type { TenantRecord } from '../../src/core/domain.js';
import type { TenantRegistry } from '../../src/ports/tenant-registry.js';
import { createInMemorySecretStore } from '../../src/adapters/secret-store.js';
import { createConnectionRouter } from '../../src/adapters/connection-router.js';

const record = (over: Partial<TenantRecord>): TenantRecord => ({
  id: 't1',
  slug: 'acme',
  region: 'aws-us-east-1',
  status: 'active',
  neonProjectId: 'proj-1',
  metadata: {},
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});

/** Registry fake that returns a fixed record (or null) by id. */
const fakeRegistry = (rec: TenantRecord | null): TenantRegistry =>
  ({
    getById: (id: string) => Promise.resolve(rec && rec.id === id ? rec : null),
  }) as TenantRegistry;

describe('createConnectionRouter', () => {
  it('resolves an active tenant with a stored secret', async () => {
    const secretStore = createInMemorySecretStore();
    await secretStore.set('t1', 'postgresql://secret@host/db');
    const router = createConnectionRouter({ registry: fakeRegistry(record({})), secretStore });
    expect(await router.resolve('t1')).toEqual({
      tenantId: 't1',
      connectionUri: 'postgresql://secret@host/db',
    });
  });

  it('throws for an unknown tenant', async () => {
    const router = createConnectionRouter({
      registry: fakeRegistry(null),
      secretStore: createInMemorySecretStore(),
    });
    await expect(router.resolve('nope')).rejects.toThrow(/not found/);
  });

  it('fails closed for a non-active tenant', async () => {
    const secretStore = createInMemorySecretStore();
    await secretStore.set('t1', 'postgresql://secret@host/db');
    const router = createConnectionRouter({
      registry: fakeRegistry(record({ status: 'suspended' })),
      secretStore,
    });
    await expect(router.resolve('t1')).rejects.toThrow(/not routable/);
  });

  it('throws when the connection secret is missing (e.g. lost / not yet stored)', async () => {
    const router = createConnectionRouter({
      registry: fakeRegistry(record({})),
      secretStore: createInMemorySecretStore(), // empty
    });
    await expect(router.resolve('t1')).rejects.toThrow(/no stored connection secret/);
  });
});
