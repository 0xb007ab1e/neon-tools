import { describe, expect, it } from 'vitest';
import type { FleetMigration, TenantMigrationState, TenantRecord } from '../../src/core/domain.js';
import type { ConnectionRouter } from '../../src/ports/connection-router.js';
import type { MigrationRunner } from '../../src/ports/migration-runner.js';
import type { TenantRegistry } from '../../src/ports/tenant-registry.js';
import { createFleetOrchestrator } from '../../src/adapters/fleet-orchestrator.js';

interface RecordedState {
  tenantId: string;
  status: string;
  error?: string;
}

interface RegistryOpts {
  active: string[];
  states?: TenantMigrationState[];
  /** Override the checksum registerMigration echoes back (to simulate drift). */
  driftChecksum?: string;
  /** Make recordTenantMigration reject (best-effort path). */
  recordThrows?: boolean;
  /** Catalog returned by listMigrations (for migrationStatus). */
  migrations?: FleetMigration[];
  /** Per-migration states keyed by migration id (for migrationStatus). */
  statesByMigration?: Record<string, TenantMigrationState[]>;
}

/** Configurable registry fake exposing the per-tenant states it recorded. */
function fakeRegistry(opts: RegistryOpts): TenantRegistry & { recorded: RecordedState[] } {
  const recorded: RecordedState[] = [];
  return {
    recorded,
    registerMigration: (m: { version: string; checksum: string }): Promise<FleetMigration> =>
      Promise.resolve({ id: 'm1', version: m.version, checksum: opts.driftChecksum ?? m.checksum }),
    list: () => Promise.resolve(opts.active.map((id) => ({ id }) as TenantRecord)),
    listMigrations: () => Promise.resolve(opts.migrations ?? []),
    listTenantMigrationStates: (migrationId: string) =>
      Promise.resolve(opts.statesByMigration?.[migrationId] ?? opts.states ?? []),
    recordTenantMigration: (
      tenantId: string,
      _migrationId: string,
      status: string,
      error?: string,
    ) => {
      if (opts.recordThrows) return Promise.reject(new Error('record failed'));
      recorded.push({ tenantId, status, ...(error !== undefined ? { error } : {}) });
      return Promise.resolve();
    },
  } as unknown as TenantRegistry & { recorded: RecordedState[] };
}

const router: ConnectionRouter = {
  resolve: (tenantId: string) => Promise.resolve({ tenantId, connectionUri: `uri-${tenantId}` }),
};

/** Runner that succeeds, except it throws (Error or raw) for ids in `failFor`. */
function fakeRunner(failFor: Record<string, unknown> = {}): MigrationRunner {
  return {
    applyToTenant: (connectionUri: string) => {
      const id = connectionUri.replace('uri-', '');
      // Intentionally reject with the raw value (sometimes a non-Error) to exercise the
      // orchestrator's `error instanceof Error ? ... : String(error)` path.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      if (id in failFor) return Promise.reject(failFor[id]);
      return Promise.resolve();
    },
  };
}

const spec = { version: '0002_audit', sql: 'CREATE TABLE IF NOT EXISTS audit ();' };

describe('createFleetOrchestrator.migrateFleet', () => {
  it('applies to all active tenants and records each applied', async () => {
    const registry = fakeRegistry({ active: ['t1', 't2', 't3'] });
    const orch = createFleetOrchestrator({
      registry,
      connectionRouter: router,
      migrationRunner: fakeRunner(),
    });
    const report = await orch.migrateFleet(spec, { batchSize: 2 });
    expect(report.succeeded.sort()).toEqual(['t1', 't2', 't3']);
    expect(report.failed).toEqual([]);
    expect(report.total).toBe(3);
    expect(report.alreadyApplied).toBe(0);
    expect(registry.recorded.filter((r) => r.status === 'applied')).toHaveLength(3);
  });

  it('is resumable: skips tenants already applied', async () => {
    const states: TenantMigrationState[] = [
      { tenantId: 't1', migrationId: 'm1', status: 'applied' },
    ];
    const registry = fakeRegistry({ active: ['t1', 't2'], states });
    const orch = createFleetOrchestrator({
      registry,
      connectionRouter: router,
      migrationRunner: fakeRunner(),
    });
    const report = await orch.migrateFleet(spec); // default batch size
    expect(report.alreadyApplied).toBe(1);
    expect(report.succeeded).toEqual(['t2']);
  });

  it('isolates failures: one tenant failing does not block others', async () => {
    const registry = fakeRegistry({ active: ['t1', 't2', 't3'] });
    const orch = createFleetOrchestrator({
      registry,
      connectionRouter: router,
      migrationRunner: fakeRunner({ t2: new Error('boom on t2') }),
    });
    const report = await orch.migrateFleet(spec, { batchSize: 3 });
    expect(report.succeeded.sort()).toEqual(['t1', 't3']);
    expect(report.failed).toEqual([{ tenantId: 't2', error: 'boom on t2' }]);
    // The failed tenant is recorded failed (resumable), others applied.
    expect(registry.recorded).toContainEqual({
      tenantId: 't2',
      status: 'failed',
      error: 'boom on t2',
    });
  });

  it('stringifies a non-Error failure', async () => {
    const registry = fakeRegistry({ active: ['t1'] });
    const orch = createFleetOrchestrator({
      registry,
      connectionRouter: router,
      migrationRunner: fakeRunner({ t1: 'raw-string-failure' }),
    });
    const report = await orch.migrateFleet(spec);
    expect(report.failed).toEqual([{ tenantId: 't1', error: 'raw-string-failure' }]);
  });

  it('still reports a failure even if recording it fails (best-effort)', async () => {
    const registry = fakeRegistry({ active: ['t1'], recordThrows: true });
    const orch = createFleetOrchestrator({
      registry,
      connectionRouter: router,
      migrationRunner: fakeRunner({ t1: new Error('apply failed') }),
    });
    const report = await orch.migrateFleet(spec);
    expect(report.failed).toEqual([{ tenantId: 't1', error: 'apply failed' }]);
  });

  it('rejects checksum drift (version re-registered with different content)', async () => {
    const registry = fakeRegistry({ active: ['t1'], driftChecksum: 'different-checksum' });
    const orch = createFleetOrchestrator({
      registry,
      connectionRouter: router,
      migrationRunner: fakeRunner(),
    });
    await expect(orch.migrateFleet(spec)).rejects.toThrow(/different checksum \(drift\)/);
  });
});

/**
 * A migration runner that records peak in-flight concurrency. `applyToTenant` yields a real
 * macrotask so overlapping calls within a batch are observable.
 */
function concurrencyTrackingRunner(): {
  runner: MigrationRunner;
  peak: () => number;
  applied: () => number;
} {
  let current = 0;
  let peak = 0;
  let applied = 0;
  return {
    runner: {
      applyToTenant: async () => {
        current += 1;
        if (current > peak) peak = current;
        await new Promise((r) => setTimeout(r, 0)); // hold the slot so concurrency is observable
        applied += 1;
        current -= 1;
      },
    },
    peak: () => peak,
    applied: () => applied,
  };
}

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `t${i}`);

// Load/soak guard: the fleet fan-out must stay BOUNDED — unbounded concurrency would blow Neon's
// API rate limits and exhaust connections (topic-reliability, threat-model R3). Heavy ad-hoc soak
// runs live in the `pnpm load` harness (src/app/load.ts); this is the fast CI regression guard.
describe('createFleetOrchestrator — load / bounded concurrency', () => {
  it('never exceeds batchSize concurrent applies across a large fleet', async () => {
    const N = 300;
    const batchSize = 20;
    const tracker = concurrencyTrackingRunner();
    const registry = fakeRegistry({ active: ids(N) });
    const orch = createFleetOrchestrator({
      registry,
      connectionRouter: router,
      migrationRunner: tracker.runner,
    });
    const report = await orch.migrateFleet(spec, { batchSize });

    expect(report.succeeded).toHaveLength(N);
    expect(report.failed).toEqual([]);
    expect(tracker.applied()).toBe(N);
    expect(tracker.peak()).toBeLessThanOrEqual(batchSize); // the safety bound
    expect(tracker.peak()).toBe(batchSize); // and the batch is actually saturated (N % batchSize === 0)
  });

  it('stays failure-isolated and resumable at scale', async () => {
    const N = 200;
    // Every 7th tenant fails this run.
    const failing = ids(N).filter((_, i) => i % 7 === 0);
    const failFor = Object.fromEntries(failing.map((id) => [id, new Error(`boom ${id}`)]));
    // Half are already applied (resumability under load).
    const preApplied = ids(N)
      .filter((_, i) => i % 2 === 0)
      .map((id) => ({ tenantId: id, migrationId: 'm1', status: 'applied' as const }));

    const registry = fakeRegistry({ active: ids(N), states: preApplied });
    const orch = createFleetOrchestrator({
      registry,
      connectionRouter: router,
      migrationRunner: fakeRunner(failFor),
    });
    const report = await orch.migrateFleet(spec, { batchSize: 25 });

    expect(report.total).toBe(N);
    expect(report.alreadyApplied).toBe(preApplied.length);
    // Every not-yet-applied tenant is either succeeded or failed — none dropped.
    const handled = report.succeeded.length + report.failed.length;
    expect(handled).toBe(N - preApplied.length);
    // Only the still-pending failing tenants surface as failures (applied ones were skipped).
    const pendingFailures = failing.filter((id) => !preApplied.some((p) => p.tenantId === id));
    expect(report.failed).toHaveLength(pendingFailures.length);
  });
});

describe('createFleetOrchestrator.migrateFleet — canary', () => {
  it('applies to the canary first, then the rest of the fleet', async () => {
    const registry = fakeRegistry({ active: ['t1', 't2', 't3'] });
    const orch = createFleetOrchestrator({
      registry,
      connectionRouter: router,
      migrationRunner: fakeRunner(),
    });
    const report = await orch.migrateFleet(spec, { canaryTenantId: 't2' });
    expect(report.canaryAborted).toBeUndefined();
    expect(report.succeeded.sort()).toEqual(['t1', 't2', 't3']);
    // The canary is applied exactly once (filtered out of the main batches).
    expect(
      registry.recorded.filter((r) => r.tenantId === 't2' && r.status === 'applied'),
    ).toHaveLength(1);
  });

  it('aborts the fleet when the canary fails (the rest are untouched)', async () => {
    const registry = fakeRegistry({ active: ['t1', 't2', 't3'] });
    const orch = createFleetOrchestrator({
      registry,
      connectionRouter: router,
      migrationRunner: fakeRunner({ t2: new Error('bad migration') }),
    });
    const report = await orch.migrateFleet(spec, { canaryTenantId: 't2' });
    expect(report.canaryAborted).toBe(true);
    expect(report.succeeded).toEqual([]);
    expect(report.failed).toEqual([{ tenantId: 't2', error: 'bad migration' }]);
    // No other tenant was applied (only the canary failure was recorded).
    expect(registry.recorded.filter((r) => r.status === 'applied')).toHaveLength(0);
  });

  it('throws when the canary is not an active tenant', async () => {
    const registry = fakeRegistry({ active: ['t1'] });
    const orch = createFleetOrchestrator({
      registry,
      connectionRouter: router,
      migrationRunner: fakeRunner(),
    });
    await expect(orch.migrateFleet(spec, { canaryTenantId: 'ghost' })).rejects.toThrow(
      /canary tenant ghost is not an active tenant/,
    );
  });
});

describe('createFleetOrchestrator.migrationStatus', () => {
  it('reports drift across the catalog for active tenants', async () => {
    const registry = fakeRegistry({
      active: ['t1', 't2', 't3'], // t3 is a brand-new tenant with no migration states
      migrations: [
        { id: 'm1', version: '0001', checksum: 'a' },
        { id: 'm2', version: '0002', checksum: 'b' },
      ],
      statesByMigration: {
        m1: [
          { tenantId: 't1', migrationId: 'm1', status: 'applied' },
          { tenantId: 't2', migrationId: 'm1', status: 'applied' },
          { tenantId: 'gone', migrationId: 'm1', status: 'applied' }, // non-active → ignored
        ],
        m2: [
          { tenantId: 't1', migrationId: 'm2', status: 'applied' },
          { tenantId: 't2', migrationId: 'm2', status: 'failed', error: 'boom' },
        ],
      },
    });
    const orch = createFleetOrchestrator({
      registry,
      connectionRouter: router,
      migrationRunner: fakeRunner(),
    });
    const report = await orch.migrationStatus();
    expect(report.latest).toBe('0002');
    expect(report.summary).toEqual({ total: 3, atLatest: 1, drifted: 2, withFailures: 1 });
    const t2 = report.tenants.find((t) => t.tenantId === 't2')!;
    expect(t2).toEqual({ tenantId: 't2', atLatest: false, missing: ['0002'], failed: ['0002'] });
    const t3 = report.tenants.find((t) => t.tenantId === 't3')!;
    expect(t3).toEqual({ tenantId: 't3', atLatest: false, missing: ['0001', '0002'], failed: [] });
  });
});
