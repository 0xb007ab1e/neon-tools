import { planSnapshotPrune, type RetentionPolicy } from '../core/snapshot.js';
import { type TenantEvent } from '../core/observability.js';
import type { SnapshotProvider, ProjectSnapshot } from '../ports/snapshot-provider.js';
import type { TenantRegistry } from '../ports/tenant-registry.js';

/** Collaborators for {@link createBackupEngine}. */
export interface BackupEngineDeps {
  /** Tenant registry (read the record; list active tenants for a sweep). */
  registry: TenantRegistry;
  /** Snapshot provider (Neon branch operations). */
  snapshots: SnapshotProvider;
  /** Default retention policy for prune sweeps. Defaults to keeping the 7 newest. */
  retention?: RetentionPolicy;
  /** Optional audit sink. */
  emit?: (event: TenantEvent) => void;
  /** Injectable clock. Defaults to `() => new Date()`. */
  now?: () => Date;
}

/** The outcome of snapshotting one tenant. */
export interface SnapshotResult {
  /** The tenant id. */
  tenantId: string;
  /** The created snapshot. */
  snapshot: ProjectSnapshot;
}

/** The result of a fleet snapshot/prune sweep. */
export interface BackupSweepReport {
  /** Active tenants examined. */
  scanned: number;
  /** Tenant ids processed successfully this sweep. */
  succeeded: string[];
  /** Tenants that failed (isolated — they don't block the sweep). */
  failed: { tenantId: string; error: string }[];
}

/** The outcome of pruning one tenant's snapshots. */
export interface PruneResult {
  /** The tenant id. */
  tenantId: string;
  /** Snapshot ids deleted under the retention policy. */
  pruned: string[];
  /** Snapshots retained. */
  kept: number;
}

/** Upper bound on tenants scanned per sweep. */
const MAX_SWEEP = 100_000;
/** Default retention: keep the 7 newest snapshots per tenant. */
const DEFAULT_RETENTION: RetentionPolicy = { maxCount: 7 };

/** Schedules per-tenant database snapshots (Neon branches) and prunes them by retention (#13). */
export interface BackupEngine {
  /**
   * Snapshot one **active, provisioned** tenant (create a Neon branch). Fail closed otherwise.
   *
   * @param tenantId - The tenant to snapshot.
   * @returns The snapshot result.
   */
  snapshot(tenantId: string): Promise<SnapshotResult>;

  /**
   * Snapshot every active tenant — the scheduled fleet sweep (cron / K8s CronJob). Failure-isolated.
   *
   * @param options - Optional scan cap.
   * @returns Per-tenant sweep report.
   */
  snapshotAll(options?: { limit?: number }): Promise<BackupSweepReport>;

  /**
   * Prune one tenant's snapshots under the retention policy (delete those beyond `maxCount` / older
   * than `maxAgeMs`).
   *
   * @param tenantId - The tenant whose snapshots to prune.
   * @param policy - Retention policy override (defaults to the engine's).
   * @returns The prune result.
   */
  prune(tenantId: string, policy?: RetentionPolicy): Promise<PruneResult>;

  /**
   * Prune every active tenant's snapshots — the scheduled retention sweep. Failure-isolated.
   *
   * @param options - Optional scan cap and retention override.
   * @returns Per-tenant sweep report.
   */
  pruneAll(options?: { limit?: number; policy?: RetentionPolicy }): Promise<BackupSweepReport>;

  /**
   * Restore a tenant's database to a snapshot (destructive recovery — overwrites live data).
   *
   * @param tenantId - The tenant to restore.
   * @param snapshotId - The snapshot (branch) id to restore from.
   */
  restore(tenantId: string, snapshotId: string): Promise<void>;
}

/**
 * Create a {@link BackupEngine} that takes scheduled point-in-time snapshots of tenant databases as
 * Neon branches (copy-on-write — instant, cheap) and prunes them by retention. Snapshots are named
 * `snapshot-<ms>`; the pure {@link planSnapshotPrune} decides what to drop. Run `snapshotAll` /
 * `pruneAll` on a schedule. Snapshots live inside the project (DR against corruption / bad
 * migrations, not project deletion — use the archive exporter for off-Neon durability).
 *
 * @param deps - Registry, snapshot provider, and optional retention / audit / clock.
 * @returns A backup engine.
 */
export function createBackupEngine(deps: BackupEngineDeps): BackupEngine {
  const now = deps.now ?? ((): Date => new Date());
  const defaultRetention = deps.retention ?? DEFAULT_RETENTION;

  const requireActive = async (tenantId: string): Promise<string> => {
    const tenant = await deps.registry.getById(tenantId);
    if (tenant === null) throw new Error(`snapshot: tenant not found: ${tenantId}`);
    if (tenant.status !== 'active' || tenant.neonProjectId === null) {
      throw new Error(`snapshot: tenant ${tenantId} must be active and provisioned`);
    }
    return tenant.neonProjectId;
  };

  const snapshot = async (tenantId: string): Promise<SnapshotResult> => {
    const neonProjectId = await requireActive(tenantId);
    const at = now();
    const created = await deps.snapshots.createSnapshot(neonProjectId, `snapshot-${at.getTime()}`);
    deps.emit?.({
      event: 'tenant.snapshot_created',
      at: at.toISOString(),
      outcome: 'ok',
      tenantId,
      context: { snapshotId: created.id, name: created.name },
    });
    return { tenantId, snapshot: created };
  };

  const prune = async (tenantId: string, policy?: RetentionPolicy): Promise<PruneResult> => {
    const neonProjectId = await requireActive(tenantId);
    const existing = await deps.snapshots.listSnapshots(neonProjectId);
    const { keep, prune: toPrune } = planSnapshotPrune(
      existing,
      policy ?? defaultRetention,
      now().getTime(),
    );
    for (const snap of toPrune) await deps.snapshots.deleteSnapshot(neonProjectId, snap.id);
    deps.emit?.({
      event: 'tenant.snapshots_pruned',
      at: now().toISOString(),
      outcome: 'ok',
      tenantId,
      context: { pruned: toPrune.length, kept: keep.length },
    });
    return { tenantId, pruned: toPrune.map((s) => s.id), kept: keep.length };
  };

  const sweep = async (
    event: string,
    op: (tenantId: string) => Promise<unknown>,
    limit: number,
  ): Promise<BackupSweepReport> => {
    const active = await deps.registry.list({ status: 'active', limit });
    const succeeded: string[] = [];
    const failed: { tenantId: string; error: string }[] = [];
    for (const tenant of active) {
      try {
        await op(tenant.id);
        succeeded.push(tenant.id);
      } catch (error) {
        failed.push({
          tenantId: tenant.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    deps.emit?.({
      event,
      at: now().toISOString(),
      outcome: failed.length > 0 ? 'error' : 'ok',
      context: { scanned: active.length, succeeded: succeeded.length, failed: failed.length },
    });
    return { scanned: active.length, succeeded, failed };
  };

  return {
    snapshot,
    prune,

    snapshotAll(options: { limit?: number } = {}): Promise<BackupSweepReport> {
      return sweep('tenant.snapshot_sweep', snapshot, options.limit ?? MAX_SWEEP);
    },

    pruneAll(
      options: { limit?: number; policy?: RetentionPolicy } = {},
    ): Promise<BackupSweepReport> {
      return sweep(
        'tenant.snapshot_prune_sweep',
        (id) => prune(id, options.policy),
        options.limit ?? MAX_SWEEP,
      );
    },

    async restore(tenantId: string, snapshotId: string): Promise<void> {
      const neonProjectId = await requireActive(tenantId);
      await deps.snapshots.restoreSnapshot(neonProjectId, snapshotId);
      deps.emit?.({
        event: 'tenant.snapshot_restored',
        at: now().toISOString(),
        outcome: 'ok',
        tenantId,
        context: { snapshotId },
      });
    },
  };
}
