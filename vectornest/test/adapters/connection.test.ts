import { describe, expect, it } from 'vitest';
import { buildPoolConfig, resolveSslConfig } from '../../src/adapters/neon-pg/connection.js';

describe('resolveSslConfig', () => {
  it('disables TLS only for sslmode=disable', () => {
    expect(resolveSslConfig('disable')).toBe(false);
  });

  it('opts out of verification only for sslmode=no-verify', () => {
    expect(resolveSslConfig('no-verify')).toEqual({ rejectUnauthorized: false });
  });

  it('verifies by default for require/verify-full/unset', () => {
    expect(resolveSslConfig('require')).toEqual({ rejectUnauthorized: true });
    expect(resolveSslConfig('verify-full')).toEqual({ rejectUnauthorized: true });
    expect(resolveSslConfig(null)).toEqual({ rejectUnauthorized: true });
  });
});

describe('buildPoolConfig', () => {
  it('strips sslmode and configures explicit verified TLS', () => {
    const config = buildPoolConfig(
      'postgresql://u:p@host.neon.tech/db?sslmode=require&channel_binding=require',
    );
    expect(config.ssl).toEqual({ rejectUnauthorized: true });
    // sslmode is removed (no deprecation warning); other params are preserved.
    expect(config.connectionString).not.toContain('sslmode');
    expect(config.connectionString).toContain('channel_binding=require');
  });

  it('honors sslmode=disable and sslmode=no-verify', () => {
    expect(buildPoolConfig('postgres://u:p@h/db?sslmode=disable').ssl).toBe(false);
    expect(buildPoolConfig('postgres://u:p@h/db?sslmode=no-verify').ssl).toEqual({
      rejectUnauthorized: false,
    });
  });

  it('defaults to verified TLS when no sslmode is present', () => {
    const config = buildPoolConfig('postgres://u:p@h/db');
    expect(config.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('falls back to passthrough with verified TLS for a non-URL DSN', () => {
    const dsn = 'host=localhost dbname=db user=u';
    const config = buildPoolConfig(dsn);
    expect(config.connectionString).toBe(dsn);
    expect(config.ssl).toEqual({ rejectUnauthorized: true });
  });
});
