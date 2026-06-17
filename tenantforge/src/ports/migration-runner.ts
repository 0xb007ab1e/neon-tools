/** The executable form of a fleet migration: a version + the SQL to apply. */
export interface MigrationExecution {
  /** Monotonic version string (e.g. `0002_add_audit`). */
  version: string;
  /** The migration SQL body to apply to a tenant database. */
  sql: string;
}

/**
 * Port: apply a single versioned migration to one tenant's database.
 *
 * The fleet orchestrator drives this over a fleet-migration plan (see `planFleetMigration`) with
 * bounded concurrency, recording per-tenant status so a run is resumable and one tenant's failure
 * never blocks the others. Migrations must be **backward-compatible (expand/contract)** so app and
 * schema can deploy independently across the fleet (ARCHITECTURE §5, topic-database).
 */
export interface MigrationRunner {
  /**
   * Apply one migration to a single tenant, idempotently (the SQL should be safe to re-run).
   *
   * @param connectionUri - The tenant database connection (resolved server-side, never client-supplied).
   * @param migration - The version + SQL to apply.
   */
  applyToTenant(connectionUri: string, migration: MigrationExecution): Promise<void>;
}
