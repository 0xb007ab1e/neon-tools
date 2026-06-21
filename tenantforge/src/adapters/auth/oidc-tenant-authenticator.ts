import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey, CryptoKey, KeyObject, JWK } from 'jose';
import type { TenantAuthenticator, TenantPrincipal } from '../../ports/tenant-authenticator.js';
import { assertHttpsUrl } from '../../core/index.js';

/** The key/key-resolver argument `jose.jwtVerify` accepts (a key, or a JWKS getter function). */
type VerifyKey = CryptoKey | KeyObject | JWK | Uint8Array | JWTVerifyGetKey;

/** Asymmetric algorithms accepted by default (no `HS*`, no `none` — avoids alg-confusion). */
const DEFAULT_ALGS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'PS256', 'PS384'];

/** Options for {@link createOidcTenantAuthenticator}. */
export interface OidcTenantAuthenticatorOptions {
  /** Expected token issuer (`iss`). */
  issuer: string;
  /** Expected audience (`aud`). */
  audience: string;
  /** The issuer's JWKS endpoint; used to build a cached remote key set when `keys` is not given. */
  jwksUri?: string;
  /** Key resolver / key (for testing — defaults to a remote JWKS set built from `jwksUri`). */
  keys?: VerifyKey;
  /** Claim carrying the tenant id the token is scoped to. Defaults to `tenant`. */
  tenantClaim?: string;
  /** Accepted signature algorithms (allow-list). Defaults to common asymmetric algs. */
  algorithms?: string[];
  /** Permit a non-https JWKS URI (local dev only — the documented leaky-endpoint opt-out). */
  allowInsecure?: boolean;
}

/**
 * Create a {@link TenantAuthenticator} that verifies a portal **JWT** against the customer IdP's JWKS
 * (via `jose`) and reads the **tenant id** from a claim — the realistic production auth for the
 * self-serve portal (vs. the static token map). The signature, `iss`, `aud`, and `exp`/`nbf` are
 * checked and the algorithm is constrained to an asymmetric allow-list (rejects `alg:none` / `HS*`
 * confusion — topic-authn-authz); the resulting principal is scoped to exactly the tenant named in
 * `tenantClaim`, so the portal still derives the tenant **only** from the verified token, never from
 * request input (no cross-tenant access — `std-owasp-api` API1). Any verification failure or a
 * missing/empty tenant claim → `null` (fail closed). JWT verification is delegated to a vetted
 * library, never hand-rolled (master §1).
 *
 * @param options - Issuer, audience, JWKS source, and the tenant claim / algorithm settings.
 * @returns An OIDC (JWT) tenant authenticator.
 */
export function createOidcTenantAuthenticator(
  options: OidcTenantAuthenticatorOptions,
): TenantAuthenticator {
  const tenantClaim = options.tenantClaim ?? 'tenant';
  const algorithms = options.algorithms ?? DEFAULT_ALGS;
  const keys: VerifyKey =
    options.keys ??
    ((): JWTVerifyGetKey => {
      if (options.jwksUri === undefined) {
        throw new Error('createOidcTenantAuthenticator: jwksUri or keys is required');
      }
      // The JWKS serves the keys that gate all portal auth — fetch it only over TLS.
      assertHttpsUrl(options.jwksUri, 'TENANTFORGE_PORTAL_OIDC_JWKS_URI', options.allowInsecure);
      return createRemoteJWKSet(new URL(options.jwksUri));
    })();

  return {
    async authenticate(token: string): Promise<TenantPrincipal | null> {
      if (token === '') return null;
      try {
        const verifyOptions = { issuer: options.issuer, audience: options.audience, algorithms };
        const { payload } =
          typeof keys === 'function'
            ? await jwtVerify(token, keys, verifyOptions)
            : await jwtVerify(token, keys, verifyOptions);
        const tenantId = payload[tenantClaim];
        if (typeof tenantId !== 'string' || tenantId === '') return null;
        return { tenantId };
      } catch {
        // Invalid signature / issuer / audience / expiry / shape → not authenticated (fail closed).
        return null;
      }
    },
  };
}
