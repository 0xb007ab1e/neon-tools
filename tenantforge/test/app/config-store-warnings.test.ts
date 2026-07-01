import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/app/config.js';

/**
 * Minimal valid env. Production additionally requires both signing keys and a `pg` evidence store —
 * supplied here so the only thing under test is the non-fatal in-memory-store advisory (gap #12),
 * which must NOT fail closed (single-replica prod with the memory default is valid).
 */
function prodEnv(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgres://u:p@host/db?sslmode=require',
    NEON_API_KEY: 'neon_key',
    NEON_ORG_ID: 'org_1',
    TENANTFORGE_SECRET_KEY: 'a-sufficiently-long-secret-key',
    TENANTFORGE_ENV: 'production',
    TENANTFORGE_ERASURE_SIGNING_KEY: 'k',
    TENANTFORGE_COMPLIANCE_SIGNING_KEY: 'k',
    TENANTFORGE_EVIDENCE_STORE: 'pg',
    ...over,
  };
}

describe('loadConfig — in-memory store multi-replica advisory (gap #12, non-fatal)', () => {
  it('warns (does NOT throw) in production when both stores are the memory default', () => {
    const config = loadConfig(prodEnv());
    expect(config.env).toBe('production');
    // It is a warning, not a fail-closed throw — single-replica prod with memory is valid.
    expect(config.rateLimitStore).toBe('memory');
    expect(config.idempotencyStore).toBe('memory');
    expect(config.warnings.some((w) => /TENANTFORGE_RATE_LIMIT_STORE=memory/.test(w))).toBe(true);
    expect(config.warnings.some((w) => /TENANTFORGE_IDEMPOTENCY_STORE=memory/.test(w))).toBe(true);
  });

  it('warns only about the rate-limit store when idempotency is pg', () => {
    const config = loadConfig(prodEnv({ TENANTFORGE_IDEMPOTENCY_STORE: 'pg' }));
    expect(config.warnings.some((w) => /TENANTFORGE_RATE_LIMIT_STORE=memory/.test(w))).toBe(true);
    expect(config.warnings.some((w) => /TENANTFORGE_IDEMPOTENCY_STORE=memory/.test(w))).toBe(false);
  });

  it('warns only about the idempotency store when rate-limit is pg', () => {
    const config = loadConfig(prodEnv({ TENANTFORGE_RATE_LIMIT_STORE: 'pg' }));
    expect(config.warnings.some((w) => /TENANTFORGE_IDEMPOTENCY_STORE=memory/.test(w))).toBe(true);
    expect(config.warnings.some((w) => /TENANTFORGE_RATE_LIMIT_STORE=memory/.test(w))).toBe(false);
  });

  it('emits NO store warnings in production when both stores are pg', () => {
    const config = loadConfig(
      prodEnv({ TENANTFORGE_RATE_LIMIT_STORE: 'pg', TENANTFORGE_IDEMPOTENCY_STORE: 'pg' }),
    );
    expect(config.warnings).toEqual([]);
  });

  it('emits NO store warnings outside production even with the memory default', () => {
    for (const env of ['development', 'test', 'staging']) {
      const config = loadConfig({
        DATABASE_URL: 'postgres://u:p@host/db?sslmode=require',
        NEON_API_KEY: 'neon_key',
        NEON_ORG_ID: 'org_1',
        TENANTFORGE_SECRET_KEY: 'a-sufficiently-long-secret-key',
        TENANTFORGE_ENV: env,
      });
      expect(config.rateLimitStore).toBe('memory');
      expect(config.warnings).toEqual([]);
    }
  });
});

describe('loadConfig — object-store evidence retention advisory (gap #15, non-fatal)', () => {
  // Non-prod: production requires `pg` (which self-deletes on prune), so object-store only appears
  // outside prod. object-store also requires TENANTFORGE_EXPORT_DIR.
  function objectStoreEnv(retentionDays: string): NodeJS.ProcessEnv {
    return {
      DATABASE_URL: 'postgres://u:p@host/db?sslmode=require',
      NEON_API_KEY: 'neon_key',
      NEON_ORG_ID: 'org_1',
      TENANTFORGE_SECRET_KEY: 'a-sufficiently-long-secret-key',
      TENANTFORGE_ENV: 'staging',
      TENANTFORGE_EVIDENCE_STORE: 'object-store',
      TENANTFORGE_EXPORT_DIR: '/var/lib/tenantforge/exports',
      TENANTFORGE_EVIDENCE_RETENTION_DAYS: retentionDays,
    };
  }
  const isRetentionWarn = (w: string): boolean =>
    /object-store with TENANTFORGE_EVIDENCE_RETENTION_DAYS/.test(w);

  it('warns (does NOT throw) when object-store has a retention window (prune leaves the body)', () => {
    const config = loadConfig(objectStoreEnv('30'));
    expect(config.evidenceStore).toBe('object-store');
    expect(config.warnings.some(isRetentionWarn)).toBe(true);
  });

  it('does NOT warn when object-store retention is indefinite (0 = keep everything)', () => {
    const config = loadConfig(objectStoreEnv('0'));
    expect(config.warnings.some(isRetentionWarn)).toBe(false);
  });

  it('does NOT warn for a non-object-store backend with a retention window', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://u:p@host/db?sslmode=require',
      NEON_API_KEY: 'neon_key',
      NEON_ORG_ID: 'org_1',
      TENANTFORGE_SECRET_KEY: 'a-sufficiently-long-secret-key',
      TENANTFORGE_ENV: 'staging',
      TENANTFORGE_EVIDENCE_STORE: 'memory',
      TENANTFORGE_EVIDENCE_RETENTION_DAYS: '30',
    });
    expect(config.warnings.some(isRetentionWarn)).toBe(false);
  });
});
