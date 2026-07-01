import { describe, expect, it } from 'vitest';
import type { TenantRecord } from '../../src/core/domain.js';
import type { TenantRegistry } from '../../src/ports/tenant-registry.js';
import type { TenantEvent } from '../../src/core/observability.js';
import type { EventSink } from '../../src/ports/event-sink.js';
import { createInMemorySecretStore } from '../../src/adapters/secret-store.js';
import { createConnectionRouter } from '../../src/adapters/connection-router.js';
import { createMetricsEventSink } from '../../src/adapters/metrics-event-sink.js';

/** A collecting {@link EventSink} for asserting the emitted `connection.resolve` SLI events. */
const collectingSink = (): { sink: EventSink; events: TenantEvent[] } => {
  const events: TenantEvent[] = [];
  return { sink: { emit: (e) => events.push(e) }, events };
};

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

/** Registry fake backed by many records, looked up by id (for cross-tenant tests). */
const multiRegistry = (recs: TenantRecord[]): TenantRegistry =>
  ({
    getById: (id: string) => Promise.resolve(recs.find((r) => r.id === id) ?? null),
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

  // The defining isolation guarantee (BOLA / cross-tenant — std-owasp-api, topic-multi-tenancy):
  // each tenant resolves to ITS OWN connection and never another's, even with both active.
  it('isolates connections per tenant (no cross-tenant bleed)', async () => {
    const secretStore = createInMemorySecretStore();
    await secretStore.set('tenant-a', 'postgresql://a@host/a');
    await secretStore.set('tenant-b', 'postgresql://b@host/b');
    const router = createConnectionRouter({
      registry: multiRegistry([
        record({ id: 'tenant-a', neonProjectId: 'proj-a' }),
        record({ id: 'tenant-b', neonProjectId: 'proj-b' }),
      ]),
      secretStore,
    });

    expect(await router.resolve('tenant-a')).toEqual({
      tenantId: 'tenant-a',
      connectionUri: 'postgresql://a@host/a',
    });
    expect(await router.resolve('tenant-b')).toEqual({
      tenantId: 'tenant-b',
      connectionUri: 'postgresql://b@host/b',
    });
    // Neither resolution returned the other tenant's URI.
    const a = await router.resolve('tenant-a');
    expect(a.connectionUri).not.toContain('b@host');
  });

  // Connection-resolution denial-rate SLI (M4).
  describe('resolution SLI (M4)', () => {
    it('emits connection.resolve ok on a successful resolution', async () => {
      const { sink, events } = collectingSink();
      const secretStore = createInMemorySecretStore();
      await secretStore.set('t1', 'postgresql://secret@host/db');
      const router = createConnectionRouter({
        registry: fakeRegistry(record({})),
        secretStore,
        eventSink: sink,
      });
      await router.resolve('t1');

      expect(events).toHaveLength(1);
      const ev = events[0]!;
      expect(ev.event).toBe('connection.resolve');
      expect(ev.outcome).toBe('ok');
      expect(ev.tenantId).toBe('t1');
      expect(typeof ev.durationMs).toBe('number');
      expect(ev.context).toEqual({ reason: 'ok' });
      // The connection URI (a secret) never reaches the event.
      expect(JSON.stringify(ev)).not.toContain('postgresql://');
    });

    it('emits error+not_found for an unknown tenant (and re-throws unchanged)', async () => {
      const { sink, events } = collectingSink();
      const router = createConnectionRouter({
        registry: fakeRegistry(null),
        secretStore: createInMemorySecretStore(),
        eventSink: sink,
      });
      await expect(router.resolve('nope')).rejects.toThrow(/not found/);
      expect(events).toHaveLength(1);
      expect(events[0]!.outcome).toBe('error');
      expect(events[0]!.tenantId).toBe('nope');
      expect(events[0]!.context).toEqual({ reason: 'not_found' });
    });

    it('emits error+not_routable for a non-active tenant (and re-throws unchanged)', async () => {
      const { sink, events } = collectingSink();
      const secretStore = createInMemorySecretStore();
      await secretStore.set('t1', 'postgresql://secret@host/db');
      const router = createConnectionRouter({
        registry: fakeRegistry(record({ status: 'suspended' })),
        secretStore,
        eventSink: sink,
      });
      await expect(router.resolve('t1')).rejects.toThrow(/not routable/);
      expect(events).toHaveLength(1);
      expect(events[0]!.outcome).toBe('error');
      expect(events[0]!.context).toEqual({ reason: 'not_routable' });
    });

    it('emits error+no_secret when the connection secret is missing (and re-throws unchanged)', async () => {
      const { sink, events } = collectingSink();
      const router = createConnectionRouter({
        registry: fakeRegistry(record({})),
        secretStore: createInMemorySecretStore(), // empty
        eventSink: sink,
      });
      await expect(router.resolve('t1')).rejects.toThrow(/no stored connection secret/);
      expect(events).toHaveLength(1);
      expect(events[0]!.outcome).toBe('error');
      expect(events[0]!.context).toEqual({ reason: 'no_secret' });
    });

    it('defaults to a no-op sink when none is injected (no throw)', async () => {
      const secretStore = createInMemorySecretStore();
      await secretStore.set('t1', 'postgresql://secret@host/db');
      const router = createConnectionRouter({ registry: fakeRegistry(record({})), secretStore });
      await expect(router.resolve('t1')).resolves.toBeDefined();
    });

    it('flows connection.resolve events end-to-end into the metrics sink (denial rate)', async () => {
      const metrics = createMetricsEventSink();
      const router = createConnectionRouter({
        registry: fakeRegistry(null),
        secretStore: createInMemorySecretStore(),
        eventSink: metrics,
      });
      await expect(router.resolve('nope')).rejects.toThrow(/not found/);
      const text = metrics.render();
      expect(text).toContain(
        'tenantforge_events_total{event="connection.resolve",outcome="error"} 1',
      );
    });
  });
});
