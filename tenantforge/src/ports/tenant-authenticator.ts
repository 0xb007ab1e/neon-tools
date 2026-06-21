/**
 * The authenticated **tenant** principal for the self-serve portal. Carries only the tenant's own
 * id — the portal derives every query from this server-side value, never from client input, so a
 * tenant can only ever see its own data (no BOLA / cross-tenant access — `std-owasp-api` API1,
 * `topic-multi-tenancy`).
 */
export interface TenantPrincipal {
  /** The tenant this principal is scoped to (and only this tenant). */
  tenantId: string;
}

/** A static portal credential: a token that authenticates as exactly one tenant. */
export interface TenantCredential {
  /** The tenant the token authenticates as. */
  tenantId: string;
  /** The portal token (a secret). */
  token: string;
}

/**
 * Port: resolve a presented portal token to the {@link TenantPrincipal} it authenticates as, or
 * `null` if it isn't valid. Distinct from the operator {@link import('./authenticator.js').Authenticator}
 * — a tenant principal is scoped to a single tenant and has no operator role/permissions.
 *
 * The default adapter matches a static per-tenant token list (constant-time); a production deploy can
 * plug in an OIDC adapter that verifies a JWT whose claim carries the tenant id. The portal owns the
 * session + the strict tenant-scoping; this only proves *which tenant* is calling.
 */
export interface TenantAuthenticator {
  /**
   * Resolve a presented portal token to the tenant it authenticates as.
   *
   * @param token - The raw portal token (empty if absent).
   * @returns The tenant principal, or `null` if the token is missing/invalid.
   */
  authenticate(token: string): Promise<TenantPrincipal | null>;
}
