import type {
  FleetMigration,
  JsonObject,
  MigrationStatus,
  TenantMigrationState,
  TenantRecord,
  TenantStatus,
} from '../core/domain.js';

/** Fields needed to create a tenant registry record. */
export interface NewTenant {
  /** Validated, unique slug. */
  slug: string;
  /** Validated region. */
  region: string;
  /** Free-form, non-sensitive metadata. */
  metadata?: JsonObject;
}

/**
 * Port: persistence for tenant *metadata* in the control-plane registry (Postgres). Holds no tenant
 * content (ARCHITECTURE §4). All SQL behind this port is parameterized; implementations never build
 * queries by string concatenation (std-owasp-proactive, lang-typescript).
 */
export interface TenantRegistry {
  /** Apply the control-plane registry schema migrations idempotently. */
  migrate(): Promise<void>;

  /**
   * Insert a new tenant in `provisioning` status. Fails if the slug already exists (idempotency is
   * enforced at the unique-slug constraint).
   *
   * @param tenant - The slug, region, and optional metadata.
   * @returns The created record.
   */
  create(tenant: NewTenant): Promise<TenantRecord>;

  /**
   * Look up a tenant by id.
   *
   * @param id - The tenant id (UUID).
   * @returns The record, or null if not found.
   */
  getById(id: string): Promise<TenantRecord | null>;

  /**
   * Look up a tenant by slug (the routing key).
   *
   * @param slug - The tenant slug.
   * @returns The record, or null if not found.
   */
  getBySlug(slug: string): Promise<TenantRecord | null>;

  /**
   * List tenant records, most-recent first.
   *
   * @param options - Optional status filter and page size.
   * @returns The matching records.
   */
  list(options?: { status?: TenantStatus; limit?: number }): Promise<TenantRecord[]>;

  /**
   * Record the Neon project id and connection-secret reference for a freshly provisioned tenant.
   *
   * @param id - The tenant id.
   * @param neonProjectId - The provisioned project id.
   */
  attachProject(id: string, neonProjectId: string): Promise<void>;

  /**
   * Update a tenant's lifecycle status.
   *
   * @param id - The tenant id.
   * @param status - The new status (the caller validates the transition via the lifecycle core).
   */
  setStatus(id: string, status: TenantStatus): Promise<void>;

  /**
   * Register a fleet migration in the catalog (idempotent by version). Returns the stored record;
   * if the version already exists, the existing record is returned (the caller checks for checksum
   * drift).
   *
   * @param migration - The version and content checksum.
   * @returns The stored catalog record.
   */
  registerMigration(migration: { version: string; checksum: string }): Promise<FleetMigration>;

  /**
   * The per-tenant state of a fleet migration (for resumability).
   *
   * @param migrationId - The migration to read state for.
   * @returns Per-tenant states recorded so far.
   */
  listTenantMigrationStates(migrationId: string): Promise<TenantMigrationState[]>;

  /**
   * Record (upsert) the outcome of applying a migration to one tenant.
   *
   * @param tenantId - The tenant.
   * @param migrationId - The migration.
   * @param status - The per-tenant outcome.
   * @param error - Failure detail when status is `failed`.
   */
  recordTenantMigration(
    tenantId: string,
    migrationId: string,
    status: MigrationStatus,
    error?: string,
  ): Promise<void>;

  /** Release underlying resources (the connection pool). */
  close(): Promise<void>;
}
