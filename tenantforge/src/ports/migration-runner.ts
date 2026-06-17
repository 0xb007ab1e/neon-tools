import type { FleetMigration } from '../core/domain.js';

/**
 * Port: apply a single versioned migration to one tenant's database.
 *
 * The fleet orchestrator drives this over a fleet-migration plan (see `planFleetMigration`) with
 * bounded concurrency, recording per-tenant status so a run is resumable and one tenant's failure
 * never blocks the others. Migrations must be **backward-compatible (expand/contract)** so
 * app and schema can deploy independently across the fleet (ARCHITECTURE §5, topic-database).
 *
 * Adapter implementation is deferred to the fleet-migration milestone (ARCHITECTURE §10).
 */
export interface MigrationRunner {
  /**
   * Apply one migration to a single tenant, idempotently.
   *
   * @param connectionUri - The tenant database connection (resolved server-side, never client-supplied).
   * @param migration - The migration to apply.
   */
  applyToTenant(connectionUri: string, migration: FleetMigration): Promise<void>;
}
