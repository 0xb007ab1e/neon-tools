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
}

/** Configurable registry fake exposing the per-tenant states it recorded. */
function fakeRegistry(opts: RegistryOpts): TenantRegistry & { recorded: RecordedState[] } {
  const recorded: RecordedState[] = [];
  return {
    recorded,
    registerMigration: (m: { version: string; checksum: string }): Promise<FleetMigration> =>
      Promise.resolve({ id: 'm1', version: m.version, checksum: opts.driftChecksum ?? m.checksum }),
    list: () => Promise.resolve(opts.active.map((id) => ({ id }) as TenantRecord)),
    listTenantMigrationStates: () => Promise.resolve(opts.states ?? []),
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
