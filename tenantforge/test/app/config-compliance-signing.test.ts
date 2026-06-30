import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/app/config.js';
import { buildComplianceReportSigner } from '../../src/app/lib.js';
import { buildComplianceReport } from '../../src/core/compliance.js';
import { verifyComplianceReport } from '../../src/core/compliance-cert.js';

/**
 * Minimal valid env. Production additionally requires BOTH signing keys (erasure + compliance); these
 * tests focus on the compliance key, so the erasure key is supplied where a full prod load is needed.
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

const sampleReport = buildComplianceReport([], {
  allowedRegions: [],
  now: new Date('2026-06-25T00:00:00.000Z'),
});

describe('loadConfig — compliance signing key (ADR-0011 startup fail-fast)', () => {
  it('omits the compliance key when unset (non-prod)', () => {
    const config = loadConfig(baseEnv());
    expect(config.complianceSigningKey).toBeUndefined();
  });

  it('FAILS FAST in production when TENANTFORGE_COMPLIANCE_SIGNING_KEY is missing', () => {
    // Provide the erasure key so the ONLY missing prod requirement is the compliance key.
    expect(() =>
      loadConfig(baseEnv({ TENANTFORGE_ENV: 'production', TENANTFORGE_ERASURE_SIGNING_KEY: 'k' })),
    ).toThrow(/TENANTFORGE_COMPLIANCE_SIGNING_KEY is required when TENANTFORGE_ENV=production/);
  });

  it('accepts production when both signing keys are provided', () => {
    // Production also requires a durable (`pg`) evidence store — supply it so this isolates the
    // compliance-key acceptance path (the evidence-store guard has its own test).
    const config = loadConfig(
      baseEnv({
        TENANTFORGE_ENV: 'production',
        TENANTFORGE_ERASURE_SIGNING_KEY: 'k',
        TENANTFORGE_COMPLIANCE_SIGNING_KEY: 'pem-or-jwk',
        TENANTFORGE_EVIDENCE_STORE: 'pg',
      }),
    );
    expect(config.complianceSigningKey).toBe('pem-or-jwk');
  });

  it('allows a missing compliance key in non-prod', () => {
    for (const env of ['development', 'test', 'staging']) {
      const config = loadConfig(baseEnv({ TENANTFORGE_ENV: env }));
      expect(config.complianceSigningKey).toBeUndefined();
    }
  });
});

describe('buildComplianceReportSigner — independent prod guard (defense-in-depth)', () => {
  it('THROWS for a hand-built Config with env=production and no key (bypasses loadConfig)', async () => {
    const config = { ...loadConfig(baseEnv()), env: 'production' as const };
    expect(config.complianceSigningKey).toBeUndefined();
    await expect(buildComplianceReportSigner(config)).rejects.toThrow(
      /refusing an ephemeral compliance-signing key in production/,
    );
  });

  it('does NOT emit an ephemeral-key warning when it refuses in production', async () => {
    const config = { ...loadConfig(baseEnv()), env: 'production' as const };
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await expect(buildComplianceReportSigner(config)).rejects.toThrow(/refusing an ephemeral/);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('non-prod with no key → an ephemeral signer whose reports verify (warns on stderr)', async () => {
    const config = loadConfig(baseEnv({ TENANTFORGE_ENV: 'development' }));
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const signer = await buildComplianceReportSigner(config);
      expect(warn).toHaveBeenCalled();
      const jws = await signer.signReport(sampleReport);
      await expect(verifyComplianceReport(jws, await signer.publicKeyJwk())).resolves.toEqual(
        sampleReport,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('production WITH a (valid) key builds a real signer, not the ephemeral path', async () => {
    const { generateKeyPair, exportPKCS8 } = await import('jose');
    const { privateKey } = await generateKeyPair('EdDSA', { extractable: true });
    const pem = await exportPKCS8(privateKey);
    const config = {
      ...loadConfig(baseEnv()),
      env: 'production' as const,
      complianceSigningKey: pem,
    };
    const signer = await buildComplianceReportSigner(config);
    const jws = await signer.signReport(sampleReport);
    await expect(verifyComplianceReport(jws, await signer.publicKeyJwk())).resolves.toEqual(
      sampleReport,
    );
  });
});
