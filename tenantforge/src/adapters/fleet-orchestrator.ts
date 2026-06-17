import { createHash } from 'node:crypto';
import { planFleetMigration } from '../core/index.js';
import type { ConnectionRouter } from '../ports/connection-router.js';
import type { MigrationRunner } from '../ports/migration-runner.js';
import type { TenantRegistry } from '../ports/tenant-registry.js';

/** A fleet migration to apply: a version + its SQL body. */
export interface FleetMigrationSpec {
  /** Monotonic version string (e.g. `0002_add_audit`). */
  version: string;
  /** The migration SQL (must be idempotent + backward-compatible — expand/contract). */
  sql: string;
}

/** Options for {@link FleetOrchestrator.migrateFleet}. */
export interface MigrateFleetOptions {
  /** Maximum tenants applied concurrently per batch (bounded fan-out). Defaults to 10. */
  batchSize?: number;
}

/** Per-tenant failure detail in a fleet-migration report. */
export interface TenantMigrationFailure {
  /** The tenant that failed. */
  tenantId: string;
  /** The failure message. */
  error: string;
}

/** The outcome of a fleet-migration run. */
export interface FleetMigrationReport {
  /** The catalog id of the migration. */
  migrationId: string;
  /** The migration version. */
  version: string;
  /** Number of eligible (active) tenants considered. */
  total: number;
  /** Tenants already applied before this run (skipped — idempotent/resumable). */
  alreadyApplied: number;
  /** Tenant ids that applied successfully this run. */
  succeeded: string[];
  /** Tenants that failed this run (isolated — they don't block others; retried next run). */
  failed: TenantMigrationFailure[];
}

/** Collaborators for {@link createFleetOrchestrator}. */
export interface FleetOrchestratorDeps {
  /** Tenant registry (eligible tenants + per-tenant migration state + catalog). */
  registry: TenantRegistry;
  /** Resolves an active tenant to its connection (fail-closed). */
  connectionRouter: ConnectionRouter;
  /** Applies a migration to one tenant database. */
  migrationRunner: MigrationRunner;
}

/** Orchestrates a versioned schema migration across the whole tenant fleet. */
export interface FleetOrchestrator {
  /**
   * Apply a migration across all active tenants: batched, bounded-concurrency, **failure-isolated**
   * (one tenant failing never blocks others), and **idempotent/resumable** (tenants already applied
   * are skipped; previously-failed/pending are retried). A fleet change is a release — runbook +
   * rollback it (ARCHITECTURE §7).
   *
   * @param spec - The migration version + SQL.
   * @param options - Batch size.
   * @returns A per-tenant report (succeeded / failed / already-applied).
   * @throws Error if the version was previously registered with a different checksum (drift).
   */
  migrateFleet(
    spec: FleetMigrationSpec,
    options?: MigrateFleetOptions,
  ): Promise<FleetMigrationReport>;
}

/** Upper bound on tenants enumerated for a fleet migration. */
const MAX_FLEET = 100_000;

/**
 * Create a {@link FleetOrchestrator} from injected collaborators.
 *
 * @param deps - The registry, connection router, and migration runner.
 * @returns A fleet orchestrator.
 */
export function createFleetOrchestrator(deps: FleetOrchestratorDeps): FleetOrchestrator {
  const { registry, connectionRouter, migrationRunner } = deps;

  return {
    async migrateFleet(
      spec: FleetMigrationSpec,
      options: MigrateFleetOptions = {},
    ): Promise<FleetMigrationReport> {
      const batchSize = options.batchSize ?? 10;
      const checksum = createHash('sha256').update(spec.sql).digest('hex');

      // Register (idempotent by version) and guard against content drift.
      const migration = await registry.registerMigration({ version: spec.version, checksum });
      if (migration.checksum !== checksum) {
        throw new Error(
          `migration ${spec.version} already registered with a different checksum (drift); ` +
            'bump the version instead of editing an applied migration',
        );
      }

      const eligible = (await registry.list({ status: 'active', limit: MAX_FLEET })).map(
        (t) => t.id,
      );
      const states = await registry.listTenantMigrationStates(migration.id);
      const plan = planFleetMigration({
        migrationId: migration.id,
        tenantIds: eligible,
        states,
        batchSize,
      });

      const succeeded: string[] = [];
      const failed: TenantMigrationFailure[] = [];

      // Batches run sequentially; tenants within a batch run concurrently (bounded by batchSize).
      // Each task catches its own error, so one tenant's failure never rejects the batch.
      for (const batch of plan.batches) {
        const outcomes = await Promise.all(
          batch.map(async (tenantId): Promise<{ tenantId: string; error?: string }> => {
            try {
              const conn = await connectionRouter.resolve(tenantId);
              await migrationRunner.applyToTenant(conn.connectionUri, {
                version: spec.version,
                sql: spec.sql,
              });
              await registry.recordTenantMigration(tenantId, migration.id, 'applied');
              return { tenantId };
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              // Best-effort record; a recording failure must not mask the original error.
              await registry
                .recordTenantMigration(tenantId, migration.id, 'failed', message)
                .catch(() => undefined);
              return { tenantId, error: message };
            }
          }),
        );
        for (const outcome of outcomes) {
          if (outcome.error === undefined) succeeded.push(outcome.tenantId);
          else failed.push({ tenantId: outcome.tenantId, error: outcome.error });
        }
      }

      return {
        migrationId: migration.id,
        version: spec.version,
        total: eligible.length,
        alreadyApplied: plan.applied.length,
        succeeded,
        failed,
      };
    },
  };
}
