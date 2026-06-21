/**
 * Transport-security guards: fail-closed assertions that every outbound connection uses TLS
 * (master §5 — "TLS 1.2+ for all network traffic, including internal service-to-service; no
 * plaintext protocols"). Pure and deterministic so they unit-test without a network. Adapters call
 * these at construction so a misconfigured plaintext endpoint is rejected at startup, not silently
 * used at runtime (fail fast — `topic-config-environments`).
 *
 * Each guard takes an explicit `allowInsecure` escape hatch (default `false`). It exists ONLY for
 * local development / tests against a loopback service that has no certificate; it is the documented
 * "potential leaky endpoint" — opting in is a deliberate, logged choice, never a default.
 */

/** Postgres `sslmode` values that actually negotiate TLS (the weaker ones may fall back to plaintext). */
const TLS_SSLMODES = new Set(['require', 'verify-ca', 'verify-full']);

/**
 * Assert a URL uses TLS (`https:`). Fails closed on any other scheme unless `allowInsecure` is set.
 *
 * @param url - The URL to check (e.g. a Vault address, OIDC JWKS URI, or PSP base URL).
 * @param label - A human label for the error (e.g. `VAULT_ADDR`).
 * @param allowInsecure - Permit a non-https scheme (local/testing only). Defaults to `false`.
 * @throws Error if the URL is malformed, or is not https and `allowInsecure` is false.
 */
export function assertHttpsUrl(url: string, label: string, allowInsecure = false): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (parsed.protocol === 'https:') return;
  if (allowInsecure) return;
  throw new Error(
    `${label} must use TLS (https://) — got "${parsed.protocol}//". ` +
      `Set the adapter's allowInsecure flag only for local/testing against a loopback service.`,
  );
}

/**
 * Assert a Postgres connection string negotiates TLS — i.e. carries `sslmode=require` (or the
 * stronger `verify-ca` / `verify-full`). Neon always requires TLS, so a real Neon URL passes; this
 * catches a misconfigured/self-hosted target with `sslmode=disable`/`allow`/`prefer` or none (which
 * can silently fall back to plaintext). Scans the query string tolerantly (a password with reserved
 * characters can defeat strict URL parsing) and fails closed unless `allowInsecure` is set.
 *
 * @param connectionString - The Postgres connection string.
 * @param label - A human label for the error (e.g. `DATABASE_URL`).
 * @param allowInsecure - Permit a connection without TLS (local dev only). Defaults to `false`.
 * @throws Error if no TLS-negotiating `sslmode` is present and `allowInsecure` is false.
 */
export function assertPostgresTls(
  connectionString: string,
  label: string,
  allowInsecure = false,
): void {
  if (allowInsecure) return;
  const match = /[?&]sslmode=([^&\s]+)/i.exec(connectionString);
  const sslmode = match?.[1]?.toLowerCase();
  if (sslmode !== undefined && TLS_SSLMODES.has(sslmode)) return;
  throw new Error(
    `${label} must enforce TLS — add "sslmode=require" (or verify-ca/verify-full) to the ` +
      `connection string. Set allowInsecure only for local development against a non-TLS Postgres.`,
  );
}
