import type { PoolConfig } from 'pg';

/**
 * Resolve a libpq-style `sslmode` into an explicit node-postgres TLS config.
 *
 * Secure by default: anything other than an explicit opt-out verifies the certificate chain and
 * hostname (`rejectUnauthorized: true`). We set this explicitly rather than letting
 * `pg-connection-string` interpret `sslmode` — its alias handling for `require`/`prefer`/`verify-ca`
 * is deprecated and changes to weaker libpq semantics in pg v9.
 *
 * @param sslmode - The `sslmode` value from the connection string, or null if absent.
 * @returns A node-postgres `ssl` config.
 */
export function resolveSslConfig(sslmode: string | null): PoolConfig['ssl'] {
  switch (sslmode) {
    case 'disable':
      return false;
    case 'no-verify':
      // Encrypt but do not verify (self-signed/dev only) — an explicit, deliberate opt-out.
      return { rejectUnauthorized: false };
    default:
      // require / prefer / verify-ca / verify-full / unset → full verification.
      return { rejectUnauthorized: true };
  }
}

/**
 * Build a node-postgres pool config from a connection string with explicit, verified TLS.
 *
 * Strips the `sslmode`/`ssl` query params (so `pg-connection-string` does not emit its deprecation
 * warning) and replaces them with an explicit {@link resolveSslConfig} result, preserving the
 * original `sslmode` intent.
 *
 * @param connectionString - The Postgres connection URL (or DSN).
 * @returns A pool config with `connectionString` and an explicit `ssl` setting.
 */
export function buildPoolConfig(connectionString: string): PoolConfig {
  try {
    const url = new URL(connectionString);
    const sslmode = url.searchParams.get('sslmode');
    url.searchParams.delete('sslmode');
    url.searchParams.delete('ssl');
    return { connectionString: url.toString(), ssl: resolveSslConfig(sslmode) };
  } catch {
    // Not a parseable URL (e.g. a key=value DSN): pass it through with verified TLS.
    return { connectionString, ssl: resolveSslConfig(null) };
  }
}
