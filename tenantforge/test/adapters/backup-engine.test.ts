import { describe, expect, it } from 'vitest';
import { createBackupEngine } from '../../src/adapters/backup-engine.js';
import type { TenantRecord } from '../../src/core/domain.js';
import type { TenantEvent } from '../../src/core/observability.js';
import type { ProjectSnapshot, SnapshotProvider } from '../../src/ports/snapshot-provider.js';
import type { TenantRegistry } from '../../src/ports/tenant-registry.js';

const tenant = (over: Partial<TenantRecord> = {}): TenantRecord => ({
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

const fakeRegistry = (tenants: TenantRecord[]): TenantRegistry =>
  ({
    getById: async (id: string) => tenants.find((t) => t.id === id) ?? null,
    list: async () => tenants.filter((t) => t.status === 'active'),
  }) as unknown as TenantRegistry;

interface FakeSnapshots extends SnapshotProvider {
  created: { projectId: string; name: string }[];
  deleted: { projectId: string; id: string }[];
}
const fakeSnapshots = (existing: ProjectSnapshot[] = []): FakeSnapshots => {
  const created: { projectId: string; name: string }[] = [];
  const deleted: { projectId: string; id: string }[] = [];
  return {
    created,
    deleted,
    createSnapshot: async (projectId, name) => {
      created.push({ projectId, name });
      return {
        id: `branch-${name}`,
        name,
        createdAt: new Date(name.replace('snapshot-', '') || 0),
      };
    },
    listSnapshots: async () => existing,
    deleteSnapshot: async (projectId, id) => {
      deleted.push({ projectId, id });
    },
    restoreSnapshot: async () => undefined,
  };
};

const clock = (ms: number) => () => new Date(ms);

describe('backup engine', () => {
  it('snapshots an active tenant, naming the branch snapshot-<ms> and emitting an event', async () => {
    const events: TenantEvent[] = [];
    const snaps = fakeSnapshots();
    const engine = createBackupEngine({
      registry: fakeRegistry([tenant()]),
      snapshots: snaps,
      emit: (e) => events.push(e),
      now: clock(1234),
    });
    const result = await engine.snapshot('t1');
    expect(snaps.created).toEqual([{ projectId: 'proj-1', name: 'snapshot-1234' }]);
    expect(result.snapshot.id).toBe('branch-snapshot-1234');
    expect(events.map((e) => e.event)).toContain('tenant.snapshot_created');
  });

  it('fails closed for a non-active or unprovisioned tenant', async () => {
    const engine = createBackupEngine({
      registry: fakeRegistry([tenant({ status: 'suspended' })]),
      snapshots: fakeSnapshots(),
    });
    await expect(engine.snapshot('t1')).rejects.toThrow(/must be active and provisioned/);
    await expect(engine.snapshot('missing')).rejects.toThrow(/tenant not found/);
  });

  it('snapshotAll is failure-isolated (one bad tenant does not block the rest) and reports the sweep', async () => {
    const events: TenantEvent[] = [];
    const tenants = [
      tenant({ id: 't1' }),
      tenant({ id: 't2', neonProjectId: null }),
      tenant({ id: 't3' }),
    ];
    const engine = createBackupEngine({
      registry: fakeRegistry(tenants),
      snapshots: fakeSnapshots(),
      emit: (e) => events.push(e),
    });
    const report = await engine.snapshotAll();
    expect(report.scanned).toBe(3);
    expect(report.succeeded.sort()).toEqual(['t1', 't3']);
    expect(report.failed.map((f) => f.tenantId)).toEqual(['t2']);
    const sweep = events.find((e) => e.event === 'tenant.snapshot_sweep');
    expect(sweep?.outcome).toBe('error'); // a failure → sweep marked error
  });

  it('pruneAll sweeps active tenants and reports per-tenant outcomes', async () => {
    const existing: ProjectSnapshot[] = [
      { id: 's1', name: 'snapshot-1', createdAt: new Date(1) },
      { id: 's2', name: 'snapshot-2', createdAt: new Date(2) },
    ];
    const snaps = fakeSnapshots(existing);
    const engine = createBackupEngine({
      registry: fakeRegistry([tenant({ id: 't1' }), tenant({ id: 't2' })]),
      snapshots: snaps,
      now: clock(100),
    });
    const report = await engine.pruneAll({ policy: { maxCount: 1 } });
    expect(report.scanned).toBe(2);
    expect(report.succeeded.sort()).toEqual(['t1', 't2']);
    // Both tenants prune s1 (older) under maxCount:1 → 2 deletions total.
    expect(snaps.deleted.map((d) => d.id)).toEqual(['s1', 's1']);
  });

  it('prunes snapshots beyond the retention policy', async () => {
    const existing: ProjectSnapshot[] = [
      { id: 's1', name: 'snapshot-1', createdAt: new Date(1) },
      { id: 's2', name: 'snapshot-2', createdAt: new Date(2) },
      { id: 's3', name: 'snapshot-3', createdAt: new Date(3) },
    ];
    const snaps = fakeSnapshots(existing);
    const engine = createBackupEngine({
      registry: fakeRegistry([tenant()]),
      snapshots: snaps,
      now: clock(100),
    });
    const result = await engine.prune('t1', { maxCount: 1 });
    expect(result.kept).toBe(1); // s3 (newest)
    expect(snaps.deleted.map((d) => d.id).sort()).toEqual(['s1', 's2']);
    expect(result.pruned.sort()).toEqual(['s1', 's2']);
  });

  it('restores a snapshot via the provider', async () => {
    let restored: { id: string } | null = null;
    const snaps = fakeSnapshots();
    snaps.restoreSnapshot = async (_projectId, id) => {
      restored = { id };
    };
    const events: TenantEvent[] = [];
    const engine = createBackupEngine({
      registry: fakeRegistry([tenant()]),
      snapshots: snaps,
      emit: (e) => events.push(e),
    });
    await engine.restore('t1', 'branch-x');
    expect(restored).toEqual({ id: 'branch-x' });
    expect(events.map((e) => e.event)).toContain('tenant.snapshot_restored');
  });
});
