import { createHash } from 'node:crypto';
import {
  computeFleetMigrationDrift,
  planFleetMigration,
  planFleetReconcile,
  type FleetDriftReport,
  type FleetReconcilePlan,
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

/** Options for {@link FleetOrchestrator.reconcileFleet} / {@link FleetOrchestrator.reconcilePlan}. */
export interface ReconcileFleetOptions {
  /** Maximum tenants reconciled concurrently per batch. Defaults to 10. */
  batchSize?: number;
  /** Reconcile up to this catalog version instead of the latest. */
  targetVersion?: string;
  /** Scan cap on active tenants (plan/preview). */
  limit?: number;
  /**
   * Reconcile this **canary** tenant fully first; if any of its migrations fail, abort the fleet
   * run (the report sets `canaryAborted`) so a bad migration is caught on one tenant.
   */
  canaryTenantId?: string;
}

/** One tenant's reconcile outcome: versions applied this run, and the version that failed (if any). */
export interface TenantReconcileOutcome {
  /** The tenant. */
  tenantId: string;
  /** Versions successfully applied this run, in order. */
  applied: string[];
  /** The first version that failed (reconcile stopped there for this tenant), with the error. */
  failed?: { version: string; error: string };
}

/** The outcome of a fleet-reconcile run. */
export interface FleetReconcileReport {
  /** The target version the fleet was reconciled toward, or null when the catalog is empty. */
  target: string | null;
  /** Tenants that needed work (were behind the target). */
  total: number;
  /** Tenants already at the target before this run (skipped). */
  alreadyAtLatest: number;
  /** Tenant ids brought fully to the target this run. */
  reconciled: string[];
  /** Tenants that hit a failure mid-sequence (stopped at the failing version; retried next run). */
  partial: TenantReconcileOutcome[];
  /** True when the canary tenant failed and the rest of the fleet was left untouched. */
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

  /**
   * Preview a fleet **reconciliation** (read-only): which active tenants are behind the target and
   * exactly which versions each would have applied. No migrations run and no SQL is needed (the plan
   * is derived from the catalog + per-tenant state), so this is safe to expose read-only (#2).
   *
   * @param options - Optional target version, batch size, and scan cap.
   * @returns The reconcile plan.
   */
  reconcilePlan(options?: ReconcileFleetOptions): Promise<FleetReconcilePlan>;

  /**
   * **Reconcile** the fleet to the target: bring every behind/failed active tenant up to date by
   * applying its missing catalog versions **in order**, stopping at a tenant's first failure (a later
   * migration must not run before an earlier one succeeds). Batched, bounded-concurrency,
   * **failure-isolated** (one tenant never blocks others) and **idempotent/resumable** (tenants at
   * the target are skipped; previously-failed versions are retried). A fleet change is a release —
   * runbook + rollback it (ARCHITECTURE §7).
   *
   * @param specs - The ordered migration catalog (version + SQL) to reconcile toward.
   * @param options - Target version, batch size, and optional canary tenant.
   * @returns A per-tenant reconcile report.
   * @throws Error if a version was previously registered with a different checksum (drift).
   */
  reconcileFleet(
    specs: readonly FleetMigrationSpec[],
    options?: ReconcileFleetOptions,
  ): Promise<FleetReconcileReport>;
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
      const tenants = await gatherProgress(
        active.map((t) => t.id),
        migrations,
      );
      return computeFleetMigrationDrift({ versions: migrations.map((m) => m.version), tenants });
    },

    async reconcilePlan(options: ReconcileFleetOptions = {}): Promise<FleetReconcilePlan> {
      const migrations = await registry.listMigrations();
      const active = await registry.list({ status: 'active', limit: options.limit ?? MAX_FLEET });
      const tenants = await gatherProgress(
        active.map((t) => t.id),
        migrations,
      );
      return planFleetReconcile({
        versions: migrations.map((m) => m.version),
        tenants,
        batchSize: options.batchSize ?? 10,
        ...(options.targetVersion !== undefined ? { target: options.targetVersion } : {}),
      });
    },

    async reconcileFleet(
      specs: readonly FleetMigrationSpec[],
      options: ReconcileFleetOptions = {},
    ): Promise<FleetReconcileReport> {
      const batchSize = options.batchSize ?? 10;
      // Register + checksum-guard each catalog migration; map version → its id + SQL.
      const byVersion = new Map<string, { migrationId: string; sql: string }>();
      const registered: { id: string; version: string }[] = [];
      for (const spec of specs) {
        const checksum = createHash('sha256').update(spec.sql).digest('hex');
        const migration = await registry.registerMigration({ version: spec.version, checksum });
        if (migration.checksum !== checksum) {
          throw new Error(
            `migration ${spec.version} already registered with a different checksum (drift); ` +
              'bump the version instead of editing an applied migration',
          );
        }
        byVersion.set(spec.version, { migrationId: migration.id, sql: spec.sql });
        registered.push({ id: migration.id, version: spec.version });
      }

      const active = await registry.list({ status: 'active', limit: MAX_FLEET });
      const activeIds = active.map((t) => t.id);
      const tenants = await gatherProgress(activeIds, registered);
      const plan = planFleetReconcile({
        versions: specs.map((s) => s.version),
        tenants,
        batchSize,
        ...(options.targetVersion !== undefined ? { target: options.targetVersion } : {}),
      });
      const missingByTenant = new Map(plan.perTenant.map((p) => [p.tenantId, p.missing]));

      // Apply a tenant's missing versions in order; stop at the first failure (ordered dependency).
      const reconcileTenant = async (
        tenantId: string,
        missing: readonly string[],
      ): Promise<TenantReconcileOutcome> => {
        const applied: string[] = [];
        for (const version of missing) {
          const m = byVersion.get(version)!;
          const outcome = await applyOne(tenantId, { version, sql: m.sql }, m.migrationId);
          if (outcome.error !== undefined) {
            return { tenantId, applied, failed: { version, error: outcome.error } };
          }
          applied.push(version);
        }
        return { tenantId, applied };
      };

      const reconciled: string[] = [];
      const partial: TenantReconcileOutcome[] = [];
      const base = {
        target: plan.target,
        total: plan.pendingTenants.length,
        alreadyAtLatest: plan.upToDate.length,
      };

      // Canary first: fully reconcile one tenant; abort the fleet run if it fails.
      const canaryId = options.canaryTenantId;
      if (canaryId !== undefined) {
        if (!activeIds.includes(canaryId)) {
          throw new Error(`canary tenant ${canaryId} is not an active tenant`);
        }
        const canaryMissing = missingByTenant.get(canaryId);
        if (canaryMissing !== undefined) {
          const outcome = await reconcileTenant(canaryId, canaryMissing);
          if (outcome.failed !== undefined) {
            return { ...base, reconciled: [], partial: [outcome], canaryAborted: true };
          }
          reconciled.push(canaryId);
        }
      }

      // Batches sequential; tenants within a batch concurrent (each isolated by reconcileTenant).
      for (const batch of plan.batches) {
        const outcomes = await Promise.all(
          batch
            .filter((tenantId) => tenantId !== canaryId)
            .map((tenantId) => reconcileTenant(tenantId, missingByTenant.get(tenantId)!)),
        );
        for (const outcome of outcomes) {
          if (outcome.failed === undefined) reconciled.push(outcome.tenantId);
          else partial.push(outcome);
        }
      }

      return { ...base, reconciled, partial };
    },
  };

  /** Gather each active tenant's applied/failed versions across the given migrations. */
  async function gatherProgress(
    activeIds: readonly string[],
    migrations: readonly { id: string; version: string }[],
  ): Promise<TenantMigrationProgress[]> {
    const applied = new Map<string, string[]>();
    const failed = new Map<string, string[]>();
    const activeSet = new Set(activeIds);
    const append = (map: Map<string, string[]>, key: string, version: string): void => {
      const versions = map.get(key);
      if (versions === undefined) map.set(key, [version]);
      else versions.push(version);
    };
    for (const migration of migrations) {
      const states = await registry.listTenantMigrationStates(migration.id);
      for (const state of states) {
        if (!activeSet.has(state.tenantId)) continue; // ignore non-active tenants
        if (state.status === 'applied') append(applied, state.tenantId, migration.version);
        else if (state.status === 'failed') append(failed, state.tenantId, migration.version);
      }
    }
    return activeIds.map((id) => ({
      tenantId: id,
      applied: applied.get(id) ?? [],
      failed: failed.get(id) ?? [],
    }));
  }
}
