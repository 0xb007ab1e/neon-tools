import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey, CryptoKey, KeyObject, JWK } from 'jose';
import { z } from 'zod';
import type { OidcCodeFlow, OidcLoginStart } from '../../ports/oidc-code-flow.js';
import type { TenantPrincipal } from '../../ports/tenant-authenticator.js';
import { assertHttpsUrl } from '../../core/index.js';

/** The key/key-resolver argument `jose.jwtVerify` accepts (a key, or a JWKS getter function). */
type VerifyKey = CryptoKey | KeyObject | JWK | Uint8Array | JWTVerifyGetKey;

/** Asymmetric algorithms accepted by default (no `HS*`, no `none` — avoids alg-confusion). */
const DEFAULT_ALGS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'PS256', 'PS384'];

/** The OIDC token-endpoint response fields we use (an `id_token` is required for the portal). */
const TokenResponseSchema = z.object({
  id_token: z.string().min(1),
  token_type: z.string().optional(),
  access_token: z.string().optional(),
  expires_in: z.number().optional(),
});

/** Options for {@link createOidcCodeFlow}. */
export interface OidcCodeFlowOptions {
  /** The IdP `authorization_endpoint` (where the browser is redirected). */
  authorizeUrl: string;
  /** The IdP `token_endpoint` (server-to-server code exchange). */
  tokenUrl: string;
  /** Expected token issuer (`iss`). */
  issuer: string;
  /** Expected audience (`aud`) — also the OAuth `client_id`. */
  audience: string;
  /** OAuth client id (usually equals {@link audience}; separated for IdPs that differ). */
  clientId: string;
  /** The redirect URI registered with the IdP (the portal callback, e.g. `https://host/portal/`). */
  redirectUri: string;
  /** OAuth scope. Defaults to `openid`. */
  scope?: string;
  /** The issuer's JWKS endpoint; used to build a cached remote key set when `keys` is not given. */
  jwksUri?: string;
  /** Key resolver / key (for testing — defaults to a remote JWKS set built from `jwksUri`). */
  keys?: VerifyKey;
  /** Claim carrying the tenant id the token is scoped to. Defaults to `tenant`. */
  tenantClaim?: string;
  /** Accepted signature algorithms (allow-list). Defaults to common asymmetric algs. */
  algorithms?: string[];
  /**
   * Optional OAuth **client secret** for a confidential client (sent to the token endpoint via HTTP
   * Basic). A secret from the secret manager / env, never committed or logged (`workflow-secrets`).
   * Omit for a public client (PKCE alone authenticates the exchange).
   */
  clientSecret?: string;
  /** Per-request timeout (ms) for the token-endpoint call. Defaults to 5000. */
  timeoutMs?: number;
  /** Max attempts for the token-endpoint call on transient failure (bounded retries). Defaults to 2. */
  maxAttempts?: number;
  /** Permit a non-https token/JWKS URL (local dev only — the documented leaky-endpoint opt-out). */
  allowInsecure?: boolean;
  /** Injectable fetch (for testing). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable randomness (for testing). Defaults to `crypto.randomBytes`-backed base64url. */
  randomString?: (bytes: number) => string;
}

/** Base64url-encode a buffer (no padding). */
function base64Url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

/** Default CSPRNG URL-safe random string (base64url of `bytes` random bytes). */
function defaultRandom(bytes: number): string {
  return base64Url(randomBytes(bytes));
}

/** S256 PKCE challenge for a verifier: base64url(SHA-256(verifier)). */
function pkceChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest());
}

/**
 * Create a server-side {@link OidcCodeFlow} (Authorization Code + PKCE). `start()` mints the
 * `state` / `nonce` / `code_verifier` and the IdP authorize URL; `exchange()` posts the `code` +
 * `code_verifier` to the token endpoint (an **untrusted upstream**: bounded timeout + retries +
 * schema validation — `topic-api-consumption`), then verifies the returned **id_token**
 * (signature / `iss` / `aud` / `exp`, asymmetric-alg allow-list — JWT verification delegated to a
 * vetted library, never hand-rolled, master §1) **and** that its `nonce` claim equals the pinned
 * value before mapping the tenant claim. Any mismatch / failure ⇒ `null` (fail closed). Supports
 * a confidential client (optional client secret via HTTP Basic) and a public client (PKCE only).
 *
 * @param options - IdP endpoints, issuer/audience/client, redirect URI, JWKS, and timeouts.
 * @returns A server-side OIDC code-flow adapter.
 */
export function createOidcCodeFlow(options: OidcCodeFlowOptions): OidcCodeFlow {
  const scope = options.scope ?? 'openid';
  const tenantClaim = options.tenantClaim ?? 'tenant';
  const algorithms = options.algorithms ?? DEFAULT_ALGS;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxAttempts = options.maxAttempts ?? 2;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const random = options.randomString ?? defaultRandom;

  // The token endpoint receives the auth code — only over TLS (a leaked endpoint defeats the flow).
  assertHttpsUrl(options.tokenUrl, 'TENANTFORGE_PORTAL_OIDC_TOKEN_URL', options.allowInsecure);

  const keys: VerifyKey =
    options.keys ??
    ((): JWTVerifyGetKey => {
      if (options.jwksUri === undefined) {
        throw new Error('createOidcCodeFlow: jwksUri or keys is required');
      }
      assertHttpsUrl(options.jwksUri, 'TENANTFORGE_PORTAL_OIDC_JWKS_URI', options.allowInsecure);
      return createRemoteJWKSet(new URL(options.jwksUri));
    })();

  /** POST the code exchange to the token endpoint with a bounded timeout (one attempt). */
  async function postOnce(body: URLSearchParams): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      };
      // Confidential client: authenticate the exchange with HTTP Basic (client_id:client_secret).
      if (options.clientSecret !== undefined) {
        const basic = Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64');
        headers.authorization = `Basic ${basic}`;
      }
      return await doFetch(options.tokenUrl, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async start(): Promise<OidcLoginStart> {
      const state = random(32);
      const nonce = random(32);
      const codeVerifier = random(64);
      const url = new URL(options.authorizeUrl);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', options.clientId);
      url.searchParams.set('redirect_uri', options.redirectUri);
      url.searchParams.set('scope', scope);
      url.searchParams.set('state', state);
      url.searchParams.set('nonce', nonce);
      url.searchParams.set('code_challenge', pkceChallenge(codeVerifier));
      url.searchParams.set('code_challenge_method', 'S256');
      return Promise.resolve({ authorizeUrl: url.toString(), state, nonce, codeVerifier });
    },

    async exchange(
      code: string,
      codeVerifier: string,
      expectedNonce: string,
    ): Promise<TenantPrincipal | null> {
      if (code === '' || codeVerifier === '' || expectedNonce === '') return null;
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: options.redirectUri,
        client_id: options.clientId,
        code_verifier: codeVerifier,
      });

      // Token-endpoint call: bounded retries on transport error / 5xx (idempotent within the short
      // code TTL); never retry a 4xx (a bad/used code won't become valid). Fail closed on exhaustion.
      let res: Response | null = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          res = await postOnce(body);
          if (res.ok || (res.status >= 400 && res.status < 500)) break;
        } catch {
          res = null; // transport error / timeout / abort — retry within the cap
        }
        if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 100 * attempt));
      }
      if (res === null || !res.ok) return null;

      let json: unknown;
      try {
        json = await res.json();
      } catch {
        return null;
      }
      const parsed = TokenResponseSchema.safeParse(json);
      if (!parsed.success) return null;

      try {
        const verifyOptions = { issuer: options.issuer, audience: options.audience, algorithms };
        const { payload } =
          typeof keys === 'function'
            ? await jwtVerify(parsed.data.id_token, keys, verifyOptions)
            : await jwtVerify(parsed.data.id_token, keys, verifyOptions);
        // Replay defence: the id_token MUST carry the nonce this flow pinned (OIDC core nonce check).
        if (typeof payload.nonce !== 'string' || payload.nonce !== expectedNonce) return null;
        const tenantId = payload[tenantClaim];
        if (typeof tenantId !== 'string' || tenantId === '') return null;
        return { tenantId };
      } catch {
        // Invalid signature / issuer / audience / expiry / shape → fail closed.
        return null;
      }
    },
  };
}
