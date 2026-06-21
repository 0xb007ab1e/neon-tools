import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey, CryptoKey, KeyObject, JWK } from 'jose';
import type { Authenticator, Principal } from '../../ports/authenticator.js';
import { isRole, isPermission, assertHttpsUrl } from '../../core/index.js';

/** The key/key-resolver argument `jose.jwtVerify` accepts (a key, or a JWKS getter function). */
type VerifyKey = CryptoKey | KeyObject | JWK | Uint8Array | JWTVerifyGetKey;

/** Asymmetric algorithms accepted by default (no `HS*`, no `none` — avoids alg-confusion). */
const DEFAULT_ALGS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'PS256', 'PS384'];

/** Options for {@link createOidcAuthenticator}. */
export interface OidcAuthenticatorOptions {
  /** Expected token issuer (`iss`). */
  issuer: string;
  /** Expected audience (`aud`). */
  audience: string;
  /** The issuer's JWKS endpoint; used to build a cached remote key set when `keys` is not given. */
  jwksUri?: string;
  /** Key resolver / key (for testing — defaults to a remote JWKS set built from `jwksUri`). */
  keys?: VerifyKey;
  /** Claim carrying the role (`admin` | `operator` | `readonly`). Defaults to `role`. */
  roleClaim?: string;
  /** Optional claim carrying an explicit permission array (overrides the role's defaults). */
  permissionsClaim?: string;
  /** Claim carrying the principal id. Defaults to `sub`. */
  subjectClaim?: string;
  /** Accepted signature algorithms (allow-list). Defaults to common asymmetric algs. */
  algorithms?: string[];
  /** Permit a non-https JWKS URI (local dev only — the documented leaky-endpoint opt-out). */
  allowInsecure?: boolean;
}

/**
 * Create an {@link Authenticator} that verifies a Bearer **JWT** against an OIDC issuer's JWKS
 * (via `jose`) — phishing-resistant, externally-managed identity. The signature, `iss`, `aud`, and
 * `exp`/`nbf` are checked; the algorithm is constrained to an asymmetric allow-list (rejects
 * `alg:none` / `HS*` confusion — topic-authn-authz). The principal id comes from `subjectClaim`
 * (`sub`) and the role from `roleClaim` (must be `admin` | `readonly`); anything else → `null`.
 *
 * JWT verification is delegated to a vetted library, never hand-rolled (master §1, std-owasp #2/#7).
 *
 * @param options - Issuer, audience, JWKS source, and claim/algorithm settings.
 * @returns An OIDC (JWT) authenticator.
 */
export function createOidcAuthenticator(options: OidcAuthenticatorOptions): Authenticator {
  const roleClaim = options.roleClaim ?? 'role';
  const subjectClaim = options.subjectClaim ?? 'sub';
  const permissionsClaim = options.permissionsClaim;
  const algorithms = options.algorithms ?? DEFAULT_ALGS;
  const keys: VerifyKey =
    options.keys ??
    ((): JWTVerifyGetKey => {
      if (options.jwksUri === undefined) {
        throw new Error('createOidcAuthenticator: jwksUri or keys is required');
      }
      // The JWKS endpoint serves the keys that gate all auth — fetch it only over TLS (a plaintext
      // JWKS is a trivial key-substitution MITM).
      assertHttpsUrl(options.jwksUri, 'TENANTFORGE_OIDC_JWKS_URI', options.allowInsecure);
      return createRemoteJWKSet(new URL(options.jwksUri));
    })();

  return {
    async authenticate(bearerToken: string): Promise<Principal | null> {
      if (bearerToken === '') return null;
      try {
        const verifyOptions = { issuer: options.issuer, audience: options.audience, algorithms };
        // Narrow so each `jwtVerify` overload matches: a getter function vs. a concrete key.
        const { payload } =
          typeof keys === 'function'
            ? await jwtVerify(bearerToken, keys, verifyOptions)
            : await jwtVerify(bearerToken, keys, verifyOptions);
        const id = payload[subjectClaim];
        const role = payload[roleClaim];
        if (typeof id !== 'string' || id === '') return null;
        if (!isRole(role)) return null;
        // Optional explicit permissions claim: only an array of known permissions narrows the grant;
        // anything malformed is ignored (fall back to the role's defaults — fail closed, not open).
        const permissions =
          permissionsClaim !== undefined && Array.isArray(payload[permissionsClaim])
            ? (payload[permissionsClaim] as unknown[]).filter(isPermission)
            : undefined;
        return permissions !== undefined ? { id, role, permissions } : { id, role };
      } catch {
        // Invalid signature / issuer / audience / expiry / shape → not authenticated (fail closed).
        return null;
      }
    },
  };
}
