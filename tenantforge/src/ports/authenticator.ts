import type { Permission, Role } from '../core/index.js';

/** A control-plane role: `admin` (all), `operator` (lifecycle, no purge), `readonly` (read). */
export type HttpRole = Role;

/** The authenticated principal resolved from a request's bearer token. */
export interface Principal {
  /** Stable principal id (for attribution + per-principal rate limiting). */
  id: string;
  /** The principal's role. */
  role: HttpRole;
  /** Explicit permissions; when present they override the role's defaults (scope an operator down). */
  permissions?: readonly Permission[];
}

/** A named operator credential — a static bearer token attributable to a principal, with a role. */
export interface HttpCredential {
  /** Stable principal id. */
  id: string;
  /** The bearer token (a secret). */
  token: string;
  /** The operator's role. */
  role: HttpRole;
  /** Explicit permissions; when present they override the role's defaults. */
  permissions?: readonly Permission[];
}

/**
 * Port: resolve a request's bearer token to a {@link Principal}, or `null` if it isn't valid.
 *
 * The default adapter matches a static per-operator credential list (constant-time); an OIDC adapter
 * verifies a JWT against an issuer's JWKS. The HTTP layer owns authorization (role checks) — the
 * authenticator only proves identity.
 */
export interface Authenticator {
  /**
   * Resolve a presented bearer token to a principal.
   *
   * @param bearerToken - The raw token from the `Authorization: Bearer …` header (empty if absent).
   * @returns The principal, or `null` if the token is missing/invalid.
   */
  authenticate(bearerToken: string): Promise<Principal | null>;
}
