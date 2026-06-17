import type { TenantMigrationState } from './domain.js';

/** Input to {@link planFleetMigration}. */
export interface FleetPlanInput {
  /** The migration being rolled out across the fleet. */
  migrationId: string;
  /** Ids of the tenants eligible for this migration (typically the `active` tenants). */
  tenantIds: readonly string[];
  /** Known per-tenant states for this migration (from a prior, possibly interrupted, run). */
  states: readonly TenantMigrationState[];
  /** Maximum tenants to apply concurrently per batch (bounded fan-out). */
  batchSize: number;
}

/** A resumable, idempotent plan for applying one migration across the fleet. */
export interface FleetMigrationPlan {
  /** The migration this plan is for. */
  migrationId: string;
  /** Tenants that already have the migration applied — skipped this run. */
  applied: string[];
  /** Tenants that still need the migration (no record, or previously pending/failed). */
  pending: string[];
  /** `pending` split into bounded batches for fan-out. */
  batches: string[][];
}

/**
 * Split a list into fixed-size chunks.
 *
 * @param items - The items to chunk.
 * @param size - The chunk size (assumed ≥ 1).
 * @returns The list split into batches of at most `size`.
 */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Plan a fleet-wide migration: classify each eligible tenant as already-applied or still-pending and
 * split the pending set into bounded batches.
 *
 * The plan is **idempotent and resumable** (master multi-tenancy rules): re-running after a partial
 * rollout skips tenants already marked `applied` and re-attempts those that are `pending`, `failed`,
 * or have no record yet — so a crash mid-fleet never re-applies or strands a tenant, and one tenant's
 * failure never blocks the others.
 *
 * @param input - Migration id, eligible tenant ids, prior per-tenant states, and batch size.
 * @returns The applied/pending split and the pending batches.
 * @throws Error if `batchSize` is not a positive integer.
 */
export function planFleetMigration(input: FleetPlanInput): FleetMigrationPlan {
  const { migrationId, tenantIds, states, batchSize } = input;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`batchSize must be a positive integer, got ${batchSize}`);
  }

  // Index only the states for *this* migration; ignore states for other migrations.
  const statusByTenant = new Map<string, TenantMigrationState['status']>();
  for (const state of states) {
    if (state.migrationId === migrationId) {
      statusByTenant.set(state.tenantId, state.status);
    }
  }

  const applied: string[] = [];
  const pending: string[] = [];
  for (const tenantId of tenantIds) {
    if (statusByTenant.get(tenantId) === 'applied') {
      applied.push(tenantId);
    } else {
      pending.push(tenantId);
    }
  }

  return { migrationId, applied, pending, batches: chunk(pending, batchSize) };
}
