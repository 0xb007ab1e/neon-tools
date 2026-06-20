import { describe, expect, it } from 'vitest';
import type { FleetMigration, TenantMigrationState, TenantRecord } from '../../src/core/domain.js';
import type { ConnectionRouter } from '../../src/ports/connection-router.js';
import type { MigrationRunner } from '../../src/ports/migration-runner.js';
import type { TenantRegistry } from '../../src/ports/tenant-registry.js';
import { createFleetOrchestrator } from '../../src/adapters/fleet-orchestrator.js';

const VERSIONS = ['0001', '0002', '0003'];
const idFor = (version: string): string => `m-${version}`;
const specs = VERSIONS.map((version) => ({ version, sql: `-- ${version}` }));

interface Recorded {
  tenantId: string;
  migrationId: string;
  status: string;
}

/** Registry fake: distinct migration id per version, seeded per-tenant states, records applies. */
function fakeRegistry(opts: {
  active: string[];
  seeded?: TenantMigrationState[];
  driftFor?: string;
}): TenantRegistry & { recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  const states = [...(opts.seeded ?? [])];
  return {
    recorded,
    registerMigration: (m: { version: string; checksum: string }): Promise<FleetMigration> =>
      Promise.resolve({
        id: idFor(m.version),
        version: m.version,
        checksum: opts.driftFor === m.version ? 'different-checksum' : m.checksum,
      }),
    list: () => Promise.resolve(opts.active.map((id) => ({ id }) as TenantRecord)),
    listMigrations: () =>
      Promise.resolve(VERSIONS.map((v) => ({ id: idFor(v), version: v }) as FleetMigration)),
    listTenantMigrationStates: (migrationId: string) =>
      Promise.resolve(
        states
          .concat(recorded.map((r) => r as unknown as TenantMigrationState))
          .filter((s) => s.migrationId === migrationId),
      ),
    recordTenantMigration: (tenantId: string, migrationId: string, status: string) => {
      recorded.push({ tenantId, migrationId, status });
      return Promise.resolve();
    },
  } as unknown as TenantRegistry & { recorded: Recorded[] };
}

const router: ConnectionRouter = {
  resolve: (tenantId: string) => Promise.resolve({ tenantId, connectionUri: `uri-${tenantId}` }),
};

/** Runner that fails for specific `${tenantId}@${version}` pairs. */
function runner(failures: string[] = []): MigrationRunner {
  const fail = new Set(failures);
  return {
    applyToTenant: (connectionUri: string, migration: { version: string }) => {
      const id = connectionUri.replace('uri-', '');
      if (fail.has(`${id}@${migration.version}`)) {
        return Promise.reject(new Error(`apply failed for ${id} at ${migration.version}`));
      }
      return Promise.resolve();
    },
  };
}

const applied = (tenantId: string, version: string): TenantMigrationState => ({
  tenantId,
  migrationId: idFor(version),
  status: 'applied',
});

describe('createFleetOrchestrator.reconcileFleet', () => {
  it('brings a behind tenant to latest by applying its missing versions in order', async () => {
    const registry = fakeRegistry({ active: ['t1'] });
    const orch = createFleetOrchestrator({
      registry,
      connectionRouter: router,
      migrationRunner: runner(),
    });
    const report = await orch.reconcileFleet(specs);
    expect(report.target).toBe('0003');
    expect(report.reconciled).toEqual(['t1']);
    expect(report.partial).toEqual([]);
    // Applied in catalog order.
    expect(registry.recorded.map((r) => r.migrationId)).toEqual(['m-0001', 'm-0002', 'm-0003']);
  });

  it('stops at a tenant first failure and never applies later versions to it (ordered dependency)', async () => {
    const registry = fakeRegistry({ active: ['t1'] });
    const orch = createFleetOrchestrator({
      registry,
      connectionRouter: router,
      migrationRunner: runner(['t1@0002']),
    });
    const report = await orch.reconcileFleet(specs);
    expect(report.reconciled).toEqual([]);
    expect(report.partial).toEqual([
      {
        tenantId: 't1',
        applied: ['0001'],
        failed: { version: '0002', error: expect.stringContaining('0002') },
      },
    ]);
    // 0003 must NOT have been attempted after 0002 failed.
    const attempted = registry.recorded.map((r) => `${r.migrationId}:${r.status}`);
    expect(attempted).toEqual(['m-0001:applied', 'm-0002:failed']);
  });

  it('isolates failures: one tenant failing does not block another', async () => {
    const registry = fakeRegistry({ active: ['t1', 't2'] });
    const orch = createFleetOrchestrator({
      registry,
      connectionRouter: router,
      migrationRunner: runner(['t1@0001']),
    });
    const report = await orch.reconcileFleet(specs);
    expect(report.reconciled).toEqual(['t2']);
    expect(report.partial.map((p) => p.tenantId)).toEqual(['t1']);
  });

  it('skips tenants already at the target (idempotent/resumable)', async () => {
    const registry = fakeRegistry({
      active: ['t1', 't2'],
      seeded: [applied('t2', '0001'), applied('t2', '0002'), applied('t2', '0003')],
    });
    const orch = createFleetOrchestrator({
      registry,
      connectionRouter: router,
      migrationRunner: runner(),
    });
    const report = await orch.reconcileFleet(specs);
    expect(report.alreadyAtLatest).toBe(1);
    expect(report.total).toBe(1);
    expect(report.reconciled).toEqual(['t1']);
  });

  it('aborts the fleet when the canary fails (others untouched)', async () => {
    const registry = fakeRegistry({ active: ['canary', 't2'] });
    const orch = createFleetOrchestrator({
      registry,
      connectionRouter: router,
      migrationRunner: runner(['canary@0001']),
    });
    const report = await orch.reconcileFleet(specs, { canaryTenantId: 'canary' });
    expect(report.canaryAborted).toBe(true);
    expect(report.reconciled).toEqual([]);
    // t2 was never touched.
    expect(registry.recorded.some((r) => r.tenantId === 't2')).toBe(false);
  });

  it('rejects a canary that is not active', async () => {
    const registry = fakeRegistry({ active: ['t1'] });
    const orch = createFleetOrchestrator({
      registry,
      connectionRouter: router,
      migrationRunner: runner(),
    });
    await expect(orch.reconcileFleet(specs, { canaryTenantId: 'ghost' })).rejects.toThrow(
      /not an active tenant/,
    );
  });

  it('throws on checksum drift for a catalog version', async () => {
    const registry = fakeRegistry({ active: ['t1'], driftFor: '0002' });
    const orch = createFleetOrchestrator({
      registry,
      connectionRouter: router,
      migrationRunner: runner(),
    });
    await expect(orch.reconcileFleet(specs)).rejects.toThrow(/different checksum/);
  });

  it('reconcilePlan previews without applying anything', async () => {
    const registry = fakeRegistry({ active: ['t1'] });
    const orch = createFleetOrchestrator({
      registry,
      connectionRouter: router,
      migrationRunner: runner(),
    });
    const plan = await orch.reconcilePlan();
    expect(plan.pendingTenants).toEqual(['t1']);
    expect(plan.perTenant[0]?.missing).toEqual(VERSIONS);
    expect(registry.recorded).toEqual([]); // read-only
  });
});
