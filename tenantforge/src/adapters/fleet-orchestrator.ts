import { createHash } from 'node:crypto';
import {
  computeFleetMigrationDrift,
  planFleetMigration,
  type FleetDriftReport,
  type TenantMigrationProgress,
} from '../core/index.js';
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
  /**
   * Apply to this **canary** tenant first; if it fails, abort the fleet rollout (the report sets
   * `canaryAborted`) so a bad migration is caught on one tenant, not the whole fleet. The canary must
   * be an active tenant.
   */
  canaryTenantId?: string;
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
  /** True when a canary tenant failed and the fleet rollout was aborted (the rest were untouched). */
  canaryAborted?: boolean;
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

  /**
   * Report fleet migration **drift**: which active tenants are behind the catalog's latest version
   * (or failing), and which are up to date. Read-only — no migrations are applied (#8).
   *
   * @param options - Optional scan cap on tenants.
   * @returns The fleet drift report.
   */
  migrationStatus(options?: { limit?: number }): Promise<FleetDriftReport>;
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

  /** Apply the migration to one tenant; records 'applied' or 'failed'. Never throws. */
  const applyOne = async (
    tenantId: string,
    spec: FleetMigrationSpec,
    migrationId: string,
  ): Promise<{ tenantId: string; error?: string }> => {
    try {
      const conn = await connectionRouter.resolve(tenantId);
      await migrationRunner.applyToTenant(conn.connectionUri, {
        version: spec.version,
        sql: spec.sql,
      });
      await registry.recordTenantMigration(tenantId, migrationId, 'applied');
      return { tenantId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Best-effort record; a recording failure must not mask the original error.
      await registry
        .recordTenantMigration(tenantId, migrationId, 'failed', message)
        .catch(() => undefined);
      return { tenantId, error: message };
    }
  };

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

      // Canary first: apply to one tenant, and abort the fleet rollout if it fails.
      const canaryId = options.canaryTenantId;
      if (canaryId !== undefined) {
        if (!eligible.includes(canaryId)) {
          throw new Error(`canary tenant ${canaryId} is not an active tenant`);
        }
        const canary = await applyOne(canaryId, spec, migration.id);
        if (canary.error !== undefined) {
          // Bad migration caught on the canary — don't touch the rest of the fleet.
          return {
            migrationId: migration.id,
            version: spec.version,
            total: eligible.length,
            alreadyApplied: plan.applied.length,
            succeeded: [],
            failed: [{ tenantId: canaryId, error: canary.error }],
            canaryAborted: true,
          };
        }
        succeeded.push(canaryId);
      }

      // Batches run sequentially; tenants within a batch run concurrently (bounded by batchSize).
      // Each task catches its own error, so one tenant's failure never rejects the batch.
      for (const batch of plan.batches) {
        const outcomes = await Promise.all(
          batch
            .filter((tenantId) => tenantId !== canaryId) // canary already applied above
            .map((tenantId) => applyOne(tenantId, spec, migration.id)),
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

    async migrationStatus(options: { limit?: number } = {}): Promise<FleetDriftReport> {
      const migrations = await registry.listMigrations();
      const active = await registry.list({ status: 'active', limit: options.limit ?? MAX_FLEET });
      // Gather each active tenant's applied/failed versions across the whole catalog.
      const applied = new Map<string, string[]>();
      const failed = new Map<string, string[]>();
      const activeIds = new Set(active.map((t) => t.id));
      const append = (map: Map<string, string[]>, key: string, version: string): void => {
        const versions = map.get(key);
        if (versions === undefined) map.set(key, [version]);
        else versions.push(version);
      };
      for (const migration of migrations) {
        const states = await registry.listTenantMigrationStates(migration.id);
        for (const state of states) {
          if (!activeIds.has(state.tenantId)) continue; // ignore non-active tenants
          if (state.status === 'applied') append(applied, state.tenantId, migration.version);
          else if (state.status === 'failed') append(failed, state.tenantId, migration.version);
        }
      }
      const tenants: TenantMigrationProgress[] = active.map((t) => ({
        tenantId: t.id,
        applied: applied.get(t.id) ?? [],
        failed: failed.get(t.id) ?? [],
      }));
      return computeFleetMigrationDrift({ versions: migrations.map((m) => m.version), tenants });
    },
  };
}
