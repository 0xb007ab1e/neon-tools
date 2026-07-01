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
 * Adapters: {@link import('../adapters/connection-router.js')} (base) and
 * {@link import('../adapters/caching-connection-router.js')} (process-local resolution cache,
 * invalidated on every transition/erasure). Wired at the composition root in `app/lib.ts`.
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
