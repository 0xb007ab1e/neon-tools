/**
 * Domain types for the control plane. Pure data shapes — no I/O, no behavior. The control-plane
 * registry stores tenant *metadata* only; tenant content never appears here (ARCHITECTURE §4).
 */

/** A JSON value (for free-form tenant metadata). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A JSON object (the `metadata` column shape). */
export type JsonObject = { [key: string]: JsonValue };

/**
 * A tenant's lifecycle status.
 *
 * - `provisioning` — the Neon project is being created; not yet routable.
 * - `active` — provisioned and serving.
 * - `suspended` — temporarily disabled (e.g. non-payment); resumable.
 * - `offboarding` — being exported + torn down; not routable.
 * - `deleted` — terminal; the Neon project has been destroyed.
 */
export type TenantStatus = 'provisioning' | 'active' | 'suspended' | 'offboarding' | 'deleted';

/** A control-plane tenant record (registry row). */
export interface TenantRecord {
  /** Tenant id (UUID). */
  id: string;
  /** URL-safe unique slug; part of the Neon project name and the routing key. */
  slug: string;
  /** Neon region the tenant's project lives in (data residency). */
  region: string;
  /** Lifecycle status. */
  status: TenantStatus;
  /** The Neon project id backing this tenant (null until provisioned). */
  neonProjectId: string | null;
  /** Free-form, non-sensitive metadata. */
  metadata: JsonObject;
  /** Creation timestamp (UTC). */
  createdAt: Date;
  /** Last-update timestamp (UTC). */
  updatedAt: Date;
}

/** Per-tenant outcome of applying one fleet migration. */
export type MigrationStatus = 'pending' | 'applied' | 'failed';

/** A registered fleet migration (the catalog row). */
export interface FleetMigration {
  /** Migration id (UUID). */
  id: string;
  /** Monotonic version string (e.g. `0002_add_audit`). */
  version: string;
  /** Content checksum of the migration body (drift detection). */
  checksum: string;
}

/** The per-tenant state of one fleet migration. */
export interface TenantMigrationState {
  /** The tenant this state is for. */
  tenantId: string;
  /** The migration this state is for. */
  migrationId: string;
  /** Whether the migration has been applied, is pending, or failed for this tenant. */
  status: MigrationStatus;
  /** Failure detail when `status === 'failed'`. */
  error?: string;
}
