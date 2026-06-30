import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/app/config.js';

/**
 * Minimal valid env. Production additionally requires BOTH signing keys (erasure + compliance) and a
 * `pg` evidence store; these are supplied where a full prod load is needed so the rule under test is
 * the only failing condition.
 */
function baseEnv(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgres://u:p@host/db?sslmode=require',
    NEON_API_KEY: 'neon_key',
    NEON_ORG_ID: 'org_1',
    TENANTFORGE_SECRET_KEY: 'a-sufficiently-long-secret-key',
    ...over,
  };
}

/** A full set of prod signing keys, so an evidence-store test isolates the evidence-store rule. */
const prodKeys = {
  TENANTFORGE_ENV: 'production',
  TENANTFORGE_ERASURE_SIGNING_KEY: 'k',
  TENANTFORGE_COMPLIANCE_SIGNING_KEY: 'k',
};

describe('loadConfig — production requires a durable evidence store (fail-closed)', () => {
  it('FAILS FAST in production when TENANTFORGE_EVIDENCE_STORE is left at the memory default', () => {
    expect(() => loadConfig(baseEnv(prodKeys))).toThrow(
      /TENANTFORGE_EVIDENCE_STORE must be .*pg.* when TENANTFORGE_ENV=production/,
    );
  });

  it('FAILS FAST in production when TENANTFORGE_EVIDENCE_STORE=memory explicitly', () => {
    expect(() =>
      loadConfig(baseEnv({ ...prodKeys, TENANTFORGE_EVIDENCE_STORE: 'memory' })),
    ).toThrow(/TENANTFORGE_EVIDENCE_STORE must be .*pg.* when TENANTFORGE_ENV=production/);
  });

  it('FAILS FAST in production when TENANTFORGE_EVIDENCE_STORE=object-store (index lost on restart)', () => {
    // object-store also needs EXPORT_DIR — provide it so the ONLY failure is the prod-durability rule.
    expect(() =>
      loadConfig(
        baseEnv({
          ...prodKeys,
          TENANTFORGE_EVIDENCE_STORE: 'object-store',
          TENANTFORGE_EXPORT_DIR: '/tmp/exports',
        }),
      ),
    ).toThrow(/TENANTFORGE_EVIDENCE_STORE must be .*pg.* when TENANTFORGE_ENV=production/);
  });

  it('accepts production when TENANTFORGE_EVIDENCE_STORE=pg', () => {
    const config = loadConfig(baseEnv({ ...prodKeys, TENANTFORGE_EVIDENCE_STORE: 'pg' }));
    expect(config.env).toBe('production');
    expect(config.evidenceStore).toBe('pg');
  });

  it('does NOT require pg outside production (memory default is fine in non-prod)', () => {
    for (const env of ['development', 'test', 'staging']) {
      const config = loadConfig(baseEnv({ TENANTFORGE_ENV: env }));
      expect(config.evidenceStore).toBe('memory');
    }
  });
});

describe('loadConfig — destructive self-serve requires a durable pending-erasure store (fail-closed)', () => {
  it('FAILS FAST when SELFSERVE_DESTRUCTIVE=true with the memory pending-erasure default', () => {
    expect(() => loadConfig(baseEnv({ TENANTFORGE_PORTAL_SELFSERVE_DESTRUCTIVE: 'true' }))).toThrow(
      /TENANTFORGE_PENDING_ERASURE_STORE must be .*pg.* when TENANTFORGE_PORTAL_SELFSERVE_DESTRUCTIVE=true/,
    );
  });

  it('FAILS FAST when SELFSERVE_DESTRUCTIVE=true with PENDING_ERASURE_STORE=memory explicitly', () => {
    expect(() =>
      loadConfig(
        baseEnv({
          TENANTFORGE_PORTAL_SELFSERVE_DESTRUCTIVE: 'true',
          TENANTFORGE_PENDING_ERASURE_STORE: 'memory',
        }),
      ),
    ).toThrow(
      /TENANTFORGE_PENDING_ERASURE_STORE must be .*pg.* when TENANTFORGE_PORTAL_SELFSERVE_DESTRUCTIVE=true/,
    );
  });

  it('accepts SELFSERVE_DESTRUCTIVE=true with PENDING_ERASURE_STORE=pg', () => {
    const config = loadConfig(
      baseEnv({
        TENANTFORGE_PORTAL_SELFSERVE_DESTRUCTIVE: 'true',
        TENANTFORGE_PENDING_ERASURE_STORE: 'pg',
      }),
    );
    expect(config.portalSelfServeDestructive).toBe(true);
    expect(config.pendingErasureStore).toBe('pg');
  });

  it('does NOT require pg when the destructive flag is OFF (default)', () => {
    const config = loadConfig(baseEnv());
    expect(config.portalSelfServeDestructive).toBe(false);
    expect(config.pendingErasureStore).toBe('memory');
  });
});
