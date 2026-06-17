import type { JsonObject, TenantRecord, TenantStatus } from '../core/domain.js';

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

  /** Release underlying resources (the connection pool). */
  close(): Promise<void>;
}
