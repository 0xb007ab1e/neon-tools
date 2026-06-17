/** A resolved, tenant-scoped database connection handle. */
export interface TenantConnection {
  /** The tenant this connection serves. */
  tenantId: string;
  /** The (pooled) connection URI scoped to the tenant's project. A secret — never logged. */
  connectionUri: string;
}

/**
 * Port: resolve an authenticated tenant id to a pooled connection scoped to that tenant's project.
 *
 * The tenant id MUST be derived **server-side** from the authenticated principal — never from a
 * client-supplied value (BOLA — std-owasp-api, topic-multi-tenancy). Resolving an unknown or
 * non-active tenant fails closed.
 *
 * Adapter implementation is deferred to the connection-routing milestone (ARCHITECTURE §10).
 */
export interface ConnectionRouter {
  /**
   * Resolve a tenant id to its (pooled) connection.
   *
   * @param tenantId - The server-derived tenant id.
   * @returns The tenant-scoped connection.
   */
  resolve(tenantId: string): Promise<TenantConnection>;
}
