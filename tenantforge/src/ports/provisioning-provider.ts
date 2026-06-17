/** A request to provision a tenant's isolated database. */
export interface ProvisionRequest {
  /** The tenant's validated slug (used to name the Neon project). */
  slug: string;
  /** The validated Neon region the project should live in (data residency). */
  region: string;
}

/** The result of provisioning a tenant's database. */
export interface ProvisionResult {
  /** The Neon project id backing the tenant. */
  neonProjectId: string;
  /**
   * The owner connection URI for the new project. A **secret** — the caller stores it via a secret
   * reference and never logs it (workflow-secrets, master §5).
   */
  connectionUri: string;
}

/**
 * Port: create and destroy a tenant's isolated database. The production adapter calls the Neon API
 * (project-per-tenant); the Neon API is an **untrusted upstream** (timeouts, bounded retries,
 * schema-validated responses — topic-api-consumption).
 */
export interface ProvisioningProvider {
  /**
   * Create an isolated Neon project for a tenant and return its id + owner connection URI.
   *
   * Should be safe to call as part of a resumable provision flow; the caller is responsible for
   * idempotency on the tenant slug.
   *
   * @param request - The tenant slug and region.
   * @returns The created project's id and connection URI.
   */
  createTenantProject(request: ProvisionRequest): Promise<ProvisionResult>;

  /**
   * Permanently delete a tenant's Neon project (offboarding — irreversible).
   *
   * @param neonProjectId - The project to delete.
   */
  deleteTenantProject(neonProjectId: string): Promise<void>;
}
