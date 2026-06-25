import { describe, expect, it } from 'vitest';
import { exportJWK, exportPKCS8, generateKeyPair, type JWK } from 'jose';
import {
  createEd25519CertificateSigner,
  createEphemeralCertificateSigner,
} from '../../src/adapters/certificate-signer.js';
import { verifyErasureCertificate } from '../../src/core/erasure-cert.js';
import { buildErasureCertificate } from '../../src/core/erasure.js';
import type { TenantRecord } from '../../src/core/domain.js';

function tenant(): TenantRecord {
  return {
    id: 't1',
    slug: 'acme',
    region: 'aws-eu-central-1',
    status: 'active',
    neonProjectId: 'proj-1',
    metadata: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

const cert = buildErasureCertificate({
  tenant: tenant(),
  reason: 'r',
  erasedAt: '2026-06-18T00:00:00.000Z',
  exported: false,
  projectDeleted: true,
  secretShredded: true,
  statusDeleted: true,
});

/** Generate a fresh Ed25519 keypair as PEM + JWK for the loader tests. */
async function freshKey(): Promise<{ pem: string; privJwk: JWK; pubJwk: JWK }> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { extractable: true });
  return {
    pem: await exportPKCS8(privateKey),
    privJwk: await exportJWK(privateKey),
    pubJwk: await exportJWK(publicKey),
  };
}

describe('createEd25519CertificateSigner — key loading', () => {
  it('loads a PKCS#8 PEM private key and signs a verifiable certificate', async () => {
    const { pem } = await freshKey();
    const signer = await createEd25519CertificateSigner({ privateKey: pem });
    const jws = await signer.sign(cert);
    await expect(verifyErasureCertificate(jws, await signer.publicKeyJwk())).resolves.toEqual(cert);
  });

  it('loads a private JWK object and signs a verifiable certificate', async () => {
    const { privJwk } = await freshKey();
    const signer = await createEd25519CertificateSigner({ privateKey: privJwk });
    const jws = await signer.sign(cert);
    await expect(verifyErasureCertificate(jws, await signer.publicKeyJwk())).resolves.toEqual(cert);
  });

  it('loads a private JWK provided as a JSON string', async () => {
    const { privJwk } = await freshKey();
    const signer = await createEd25519CertificateSigner({ privateKey: JSON.stringify(privJwk) });
    const jws = await signer.sign(cert);
    await expect(verifyErasureCertificate(jws, await signer.publicKeyJwk())).resolves.toEqual(cert);
  });

  it('exposes only the PUBLIC JWK (never the private `d` member)', async () => {
    const { privJwk } = await freshKey();
    const signer = await createEd25519CertificateSigner({ privateKey: privJwk });
    const pub = await signer.publicKeyJwk();
    expect(pub.kty).toBe('OKP');
    expect(pub.crv).toBe('Ed25519');
    expect(pub.d).toBeUndefined();
    expect(pub.x).toBeDefined();
  });

  it('the public JWK getter returns a fresh copy each call (caller cannot mutate the shared key)', async () => {
    const { privJwk } = await freshKey();
    const signer = await createEd25519CertificateSigner({ privateKey: privJwk });
    const a = await signer.publicKeyJwk();
    (a as Record<string, unknown>).x = 'tampered';
    const b = await signer.publicKeyJwk();
    expect(b.x).not.toBe('tampered');
  });

  it('fails fast on a JWK that is not an Ed25519 private key (no `d`)', async () => {
    const { pubJwk } = await freshKey();
    await expect(createEd25519CertificateSigner({ privateKey: pubJwk })).rejects.toThrow(
      /must be an Ed25519 private key/,
    );
  });

  it('fails fast on a non-Ed25519 JWK (wrong kty)', async () => {
    await expect(
      createEd25519CertificateSigner({ privateKey: { kty: 'EC', crv: 'P-256', d: 'x' } }),
    ).rejects.toThrow(/must be an Ed25519 private key/);
  });

  it('fails fast on a garbage key string (neither PEM nor JWK JSON)', async () => {
    await expect(
      createEd25519CertificateSigner({ privateKey: 'definitely-not-a-key' }),
    ).rejects.toThrow(/not valid PKCS#8 PEM or JWK JSON/);
  });

  it('rejects a PKCS#8 PEM for the wrong key type (e.g. an RSA key)', async () => {
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const rsaPem = await exportPKCS8(privateKey);
    await expect(createEd25519CertificateSigner({ privateKey: rsaPem })).rejects.toThrow();
  });
});

describe('createEphemeralCertificateSigner', () => {
  it('generates a working keypair whose certificates verify', async () => {
    const signer = await createEphemeralCertificateSigner();
    const jws = await signer.sign(cert);
    await expect(verifyErasureCertificate(jws, await signer.publicKeyJwk())).resolves.toEqual(cert);
  });

  it('two ephemeral signers produce different (non-interchangeable) keys', async () => {
    const a = await createEphemeralCertificateSigner();
    const b = await createEphemeralCertificateSigner();
    const jwsA = await a.sign(cert);
    // a's token does not verify under b's key (distinct keypairs — not verifiable across restarts).
    await expect(verifyErasureCertificate(jwsA, await b.publicKeyJwk())).rejects.toThrow();
  });
});
