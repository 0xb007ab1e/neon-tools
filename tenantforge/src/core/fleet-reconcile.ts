import type { TenantMigrationProgress } from './fleet-drift.js';

/** Input to {@link planFleetReconcile}. */
export interface FleetReconcileInput {
  /** The migration catalog versions, in order (the last is "latest"). */
  versions: readonly string[];
  /** Per-tenant applied/failed progress across the catalog. */
  tenants: readonly TenantMigrationProgress[];
  /**
   * Reconcile up to (and including) this version; defaults to the latest. Lets an operator roll the
   * fleet forward to a specific checkpoint rather than always to head.
   */
  target?: string;
  /** Maximum tenants reconciled concurrently per batch (bounded fan-out). */
  batchSize: number;
}

/** One tenant's reconcile work: the ordered versions it still needs to reach the target. */
export interface TenantReconcilePlan {
  /** The tenant. */
  tenantId: string;
  /** Versions to apply, in catalog order (the tenant is behind by exactly these). */
  missing: string[];
}

/** A resumable, idempotent plan for bringing the fleet up to a target version. */
export interface FleetReconcilePlan {
  /** The target version every tenant is being brought to, or null when the catalog is empty. */
  target: string | null;
  /** Tenants with work to do (missing ≥ 1 version), each with its ordered missing versions. */
  perTenant: TenantReconcilePlan[];
  /** Ids of the tenants needing work (== `perTenant` ids), for fan-out. */
  pendingTenants: string[];
  /** Tenants already at the target — skipped this run. */
  upToDate: string[];
  /** Total number of (tenant, version) applications the plan would perform. */
  totalMissing: number;
  /** `pendingTenants` split into bounded batches. */
  batches: string[][];
}

/** Split a list into fixed-size chunks. */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Plan a fleet **reconciliation**: bring every active tenant up to a target catalog version by
 * computing, per tenant, the ordered set of versions it is still missing (#2, the actuator behind
 * the read-only drift report). Pure and deterministic — the decision, no I/O.
 *
 * Unlike {@link planFleetMigration} (one version across the fleet), this spans the whole catalog up
 * to the target: each tenant's `missing` list is the versions it has not applied, **in catalog
 * order**, so the executor applies them as an ordered, dependency-respecting sequence and stops at a
 * tenant's first failure (a later migration must not run before an earlier one succeeds). It is
 * idempotent/resumable: tenants already at the target are skipped; a previously-failed version
 * reappears as `missing` and is retried.
 *
 * @param input - Catalog versions (ordered), per-tenant progress, optional target, and batch size.
 * @returns The per-tenant reconcile plan and batches.
 * @throws Error if `batchSize` is not a positive integer, or `target` is not a catalog version.
 */
export function planFleetReconcile(input: FleetReconcileInput): FleetReconcilePlan {
  const { versions, tenants, batchSize } = input;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`batchSize must be a positive integer, got ${batchSize}`);
  }

  if (versions.length === 0) {
    return {
      target: null,
      perTenant: [],
      pendingTenants: [],
      upToDate: tenants.map((t) => t.tenantId),
      totalMissing: 0,
      batches: [],
    };
  }

  const target = input.target ?? versions[versions.length - 1]!;
  const targetIndex = versions.indexOf(target);
  if (targetIndex === -1) {
    throw new Error(`target version ${target} is not in the migration catalog`);
  }
  // Reconcile only up to (and including) the target — versions past it are out of scope this run.
  const inScope = versions.slice(0, targetIndex + 1);

  const perTenant: TenantReconcilePlan[] = [];
  const upToDate: string[] = [];
  let totalMissing = 0;
  for (const tenant of tenants) {
    const applied = new Set(tenant.applied);
    const missing = inScope.filter((v) => !applied.has(v));
    if (missing.length === 0) {
      upToDate.push(tenant.tenantId);
    } else {
      perTenant.push({ tenantId: tenant.tenantId, missing });
      totalMissing += missing.length;
    }
  }

  const pendingTenants = perTenant.map((p) => p.tenantId);
  return {
    target,
    perTenant,
    pendingTenants,
    upToDate,
    totalMissing,
    batches: chunk(pendingTenants, batchSize),
  };
}
