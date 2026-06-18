/** One tenant's progress against the migration catalog. */
export interface TenantMigrationProgress {
  /** The tenant. */
  tenantId: string;
  /** Catalog versions this tenant has applied. */
  applied: readonly string[];
  /** Catalog versions that failed for this tenant. */
  failed: readonly string[];
}

/** Inputs to {@link computeFleetMigrationDrift}. */
export interface FleetDriftInput {
  /** The migration catalog versions, in order (the last is "latest"). */
  versions: readonly string[];
  /** Per-tenant progress. */
  tenants: readonly TenantMigrationProgress[];
}

/** One tenant's drift verdict. */
export interface TenantDrift {
  /** The tenant. */
  tenantId: string;
  /** True when the tenant has applied every catalog version. */
  atLatest: boolean;
  /** Catalog versions the tenant has not applied. */
  missing: string[];
  /** Catalog versions that failed for the tenant. */
  failed: string[];
}

/** A fleet-wide migration drift report. */
export interface FleetDriftReport {
  /** The latest catalog version, or null when the catalog is empty. */
  latest: string | null;
  /** Number of catalog versions. */
  totalVersions: number;
  /** Per-tenant drift. */
  tenants: TenantDrift[];
  /** Roll-up counts. */
  summary: {
    /** Total tenants. */
    total: number;
    /** Tenants that have applied every catalog version. */
    atLatest: number;
    /** Tenants missing at least one version. */
    drifted: number;
    /** Tenants with at least one failed migration. */
    withFailures: number;
  };
}

/**
 * Compute fleet-wide migration **drift** from the catalog + per-tenant progress (#8) — the pure
 * decision behind "which tenants are behind / failing." A tenant is *at latest* when it has applied
 * every catalog version; otherwise it is *drifted* (the missing versions are listed). Failures are
 * surfaced per tenant. Pure and deterministic (catalog order preserved).
 *
 * @param input - The catalog versions (ordered) and each tenant's applied/failed versions.
 * @returns The drift report.
 */
export function computeFleetMigrationDrift(input: FleetDriftInput): FleetDriftReport {
  const latest = input.versions.length > 0 ? input.versions[input.versions.length - 1]! : null;

  const tenants: TenantDrift[] = input.tenants.map((tenant) => {
    const applied = new Set(tenant.applied);
    const failedSet = new Set(tenant.failed);
    const missing = input.versions.filter((v) => !applied.has(v));
    const failed = input.versions.filter((v) => failedSet.has(v));
    return { tenantId: tenant.tenantId, atLatest: missing.length === 0, missing, failed };
  });

  return {
    latest,
    totalVersions: input.versions.length,
    tenants,
    summary: {
      total: tenants.length,
      atLatest: tenants.filter((t) => t.atLatest).length,
      drifted: tenants.filter((t) => !t.atLatest).length,
      withFailures: tenants.filter((t) => t.failed.length > 0).length,
    },
  };
}
