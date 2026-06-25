import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/app/config.js';
import { buildCertificateSigner } from '../../src/app/lib.js';
import { verifyErasureCertificate } from '../../src/core/erasure-cert.js';
import { buildErasureCertificate } from '../../src/core/erasure.js';
import type { TenantRecord } from '../../src/core/domain.js';

/** Minimal valid env for the control plane (registry + Neon API + secret key). */
function baseEnv(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgres://u:p@host/db?sslmode=require',
    NEON_API_KEY: 'neon_key',
    NEON_ORG_ID: 'org_1',
    TENANTFORGE_SECRET_KEY: 'a-sufficiently-long-secret-key',
    ...over,
  };
}

describe('loadConfig — erasure signing key (always-signed startup fail-fast)', () => {
  it('defaults TENANTFORGE_ENV to development and omits the key when unset', () => {
    const config = loadConfig(baseEnv());
    expect(config.env).toBe('development');
    expect(config.erasureSigningKey).toBeUndefined();
  });

  it('FAILS FAST in production when TENANTFORGE_ERASURE_SIGNING_KEY is missing', () => {
    expect(() => loadConfig(baseEnv({ TENANTFORGE_ENV: 'production' }))).toThrow(
      /TENANTFORGE_ERASURE_SIGNING_KEY is required when TENANTFORGE_ENV=production/,
    );
  });

  it('accepts production when a signing key is provided', () => {
    const config = loadConfig(
      baseEnv({ TENANTFORGE_ENV: 'production', TENANTFORGE_ERASURE_SIGNING_KEY: 'pem-or-jwk' }),
    );
    expect(config.env).toBe('production');
    expect(config.erasureSigningKey).toBe('pem-or-jwk');
  });

  it('allows a missing key in non-prod (the ephemeral-key path is taken at wiring time)', () => {
    for (const env of ['development', 'test', 'staging']) {
      const config = loadConfig(baseEnv({ TENANTFORGE_ENV: env }));
      expect(config.erasureSigningKey).toBeUndefined();
    }
  });
});

const sampleTenant: TenantRecord = {
  id: 't1',
  slug: 'acme',
  region: 'aws-us-east-1',
  status: 'active',
  neonProjectId: 'p1',
  metadata: {},
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
const sampleCert = buildErasureCertificate({
  tenant: sampleTenant,
  reason: 'r',
  erasedAt: '2026-06-18T00:00:00.000Z',
  exported: false,
  projectDeleted: true,
  secretShredded: true,
  statusDeleted: true,
});

describe('buildCertificateSigner — independent prod guard (L1, defense-in-depth)', () => {
  it('THROWS for a hand-built Config with env=production and no key (bypasses loadConfig/superRefine)', async () => {
    // A Config produced WITHOUT going through superRefine's prod branch (constructed from a
    // development load, then mutated). The guard must fail closed locally, not rely on loadConfig.
    const config = { ...loadConfig(baseEnv()), env: 'production' as const };
    expect(config.erasureSigningKey).toBeUndefined();
    await expect(buildCertificateSigner(config)).rejects.toThrow(
      /refusing an ephemeral erasure-signing key in production/,
    );
  });

  it('does NOT emit an ephemeral-key warning when it refuses in production', async () => {
    const config = { ...loadConfig(baseEnv()), env: 'production' as const };
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await expect(buildCertificateSigner(config)).rejects.toThrow(/refusing an ephemeral/);
      // Fail closed BEFORE generating/warning about an ephemeral key.
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('non-prod with no key → an ephemeral signer whose certificates verify (warns on stderr)', async () => {
    const config = loadConfig(baseEnv({ TENANTFORGE_ENV: 'development' }));
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const signer = await buildCertificateSigner(config);
      expect(warn).toHaveBeenCalled(); // the non-prod ephemeral warning fired
      const jws = await signer.sign(sampleCert);
      await expect(verifyErasureCertificate(jws, await signer.publicKeyJwk())).resolves.toEqual(
        sampleCert,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('production WITH a (valid) key builds a real signer, not the ephemeral path', async () => {
    // Use a real Ed25519 PEM so the configured path succeeds end-to-end.
    const { generateKeyPair, exportPKCS8 } = await import('jose');
    const { privateKey } = await generateKeyPair('EdDSA', { extractable: true });
    const pem = await exportPKCS8(privateKey);
    const config = {
      ...loadConfig(baseEnv()),
      env: 'production' as const,
      erasureSigningKey: pem,
    };
    const signer = await buildCertificateSigner(config);
    const jws = await signer.sign(sampleCert);
    await expect(verifyErasureCertificate(jws, await signer.publicKeyJwk())).resolves.toEqual(
      sampleCert,
    );
  });
});
