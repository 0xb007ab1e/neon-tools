import type { TenantPrincipal } from './tenant-authenticator.js';

/**
 * The transient login parameters the **server** generates to begin an OIDC Authorization Code + PKCE
 * flow. The portal pins `state`, `nonce`, and `codeVerifier` in a short-TTL signed, HttpOnly cookie
 * (never handed to the SPA) and hands the SPA only the `authorizeUrl` to redirect to. Pinning these
 * server-side is what defeats login-CSRF and replay (the SPA can't forge a callback for a flow it
 * didn't start) — `topic-authn-authz`, `std-owasp` A01/A07.
 */
export interface OidcLoginStart {
  /** The IdP authorize URL the browser redirects to (carries `code_challenge`, `state`, `nonce`). */
  authorizeUrl: string;
  /** Opaque anti-CSRF value echoed back on the callback; verified equal server-side. */
  state: string;
  /** Replay-binding value embedded in the request; verified equal to the id_token's `nonce` claim. */
  nonce: string;
  /** PKCE code verifier; the matching S256 challenge went to the IdP. Kept server-side only. */
  codeVerifier: string;
}

/**
 * Port: the **server-side** OIDC Authorization Code + PKCE flow for the portal login. The SPA never
 * sees a raw token — it only redirects to {@link OidcLoginStart.authorizeUrl} and posts back the
 * `code` + `state`. The adapter exchanges the code at the IdP **token endpoint** (an untrusted
 * upstream — timeout / bounded retries / schema-validated — `topic-api-consumption`), verifies the
 * returned **id_token** (signature / `iss` / `aud` / `exp`, asymmetric-alg allow-list) **and** that
 * its `nonce` claim equals the one this flow pinned, then maps the tenant claim to a
 * {@link TenantPrincipal}. Any mismatch / verification failure ⇒ `null` (fail closed).
 */
export interface OidcCodeFlow {
  /**
   * Begin a login: generate `state`, `nonce`, and the PKCE `code_verifier`, and build the IdP
   * authorize URL (S256 challenge). The caller pins state/nonce/verifier in a signed cookie.
   *
   * @returns The authorize URL plus the server-pinned `state` / `nonce` / `codeVerifier`.
   */
  start(): Promise<OidcLoginStart>;

  /**
   * Complete a login: exchange `code` (+ the pinned `codeVerifier`) at the token endpoint, verify the
   * id_token and that its `nonce` equals `expectedNonce`, and map the tenant claim.
   *
   * @param code - The authorization code from the callback (untrusted client input).
   * @param codeVerifier - The PKCE verifier this flow pinned server-side.
   * @param expectedNonce - The nonce this flow pinned; must equal the id_token's `nonce` claim.
   * @returns The tenant principal on full success, or `null` on any failure (fail closed).
   */
  exchange(
    code: string,
    codeVerifier: string,
    expectedNonce: string,
  ): Promise<TenantPrincipal | null>;
}
