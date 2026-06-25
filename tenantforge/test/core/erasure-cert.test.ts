import { describe, expect, it } from 'vitest';
import { CompactSign, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { buildErasureCertificate, type ErasureCertificate } from '../../src/core/erasure.js';
import {
  verifyErasureCertificate,
  erasureCertClaims,
  ERASURE_CERT_ALG,
  ERASURE_CERT_TYP,
} from '../../src/core/erasure-cert.js';
import {
  createEd25519CertificateSigner,
  createEphemeralCertificateSigner,
} from '../../src/adapters/certificate-signer.js';
import type { TenantRecord } from '../../src/core/domain.js';

function tenant(overrides: Partial<TenantRecord> = {}): TenantRecord {
  return {
    id: 't1',
    slug: 'acme',
    region: 'aws-eu-central-1',
    status: 'active',
    neonProjectId: 'proj-1',
    metadata: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function sampleCert(
  overrides: Omit<Partial<ErasureCertificate>, 'exportLocation'> = {},
  opts: { withExportLocation?: boolean } = {},
): ErasureCertificate {
  const withExportLocation = opts.withExportLocation ?? true;
  const base = buildErasureCertificate({
    tenant: tenant(),
    reason: 'GDPR Art.17 #1',
    erasedAt: '2026-06-18T00:00:00.000Z',
    exported: true,
    ...(withExportLocation ? { exportLocation: 's3://exports/t1.dump' } : {}),
    projectDeleted: true,
    secretShredded: true,
    statusDeleted: true,
  });
  return { ...base, ...overrides };
}

describe('erasure-cert sign → verify round-trip', () => {
  it('signs a certificate and verifies it back to the identical claims (ephemeral key)', async () => {
    const signer = await createEphemeralCertificateSigner();
    const cert = sampleCert();
    const jws = await signer.sign(cert);
    const pub = await signer.publicKeyJwk();
    await expect(verifyErasureCertificate(jws, pub)).resolves.toEqual(cert);
  });

  it('round-trips a minimal certificate (no exportLocation)', async () => {
    const signer = await createEphemeralCertificateSigner();
    const cert = sampleCert({ exported: false }, { withExportLocation: false });
    expect(cert.exportLocation).toBeUndefined();
    const jws = await signer.sign(cert);
    const verified = await verifyErasureCertificate(jws, await signer.publicKeyJwk());
    expect(verified).toEqual(cert);
    expect('exportLocation' in verified).toBe(false);
  });

  it('round-trips a verified=false (unproven) certificate without coercion', async () => {
    const signer = await createEphemeralCertificateSigner();
    const cert = sampleCert({
      verified: false,
      verification: { secretShredded: false, statusDeleted: true },
    });
    const jws = await signer.sign(cert);
    await expect(verifyErasureCertificate(jws, await signer.publicKeyJwk())).resolves.toEqual(cert);
  });

  it('the protected header pins alg=EdDSA and the domain typ', async () => {
    const signer = await createEphemeralCertificateSigner();
    const jws = await signer.sign(sampleCert());
    const header = JSON.parse(Buffer.from(jws.split('.')[0]!, 'base64url').toString('utf8'));
    expect(header.alg).toBe('EdDSA');
    expect(header.typ).toBe(ERASURE_CERT_TYP);
  });
});

describe('erasure-cert verify — abuse / fail-closed (untrusted input)', () => {
  it('rejects a TAMPERED payload (signature no longer matches)', async () => {
    const signer = await createEphemeralCertificateSigner();
    const jws = await signer.sign(sampleCert());
    const [h, , s] = jws.split('.');
    // Flip the payload to a different cert body but keep the original signature.
    const forgedPayload = Buffer.from(
      JSON.stringify({ cert: erasureCertClaims(sampleCert({ tenantId: 'attacker' })) }),
    ).toString('base64url');
    const tampered = `${h}.${forgedPayload}.${s}`;
    await expect(verifyErasureCertificate(tampered, await signer.publicKeyJwk())).rejects.toThrow(
      /signature verification failed/,
    );
  });

  it('rejects verification with the WRONG public key (different keypair)', async () => {
    const signer = await createEphemeralCertificateSigner();
    const other = await createEphemeralCertificateSigner();
    const jws = await signer.sign(sampleCert());
    await expect(verifyErasureCertificate(jws, await other.publicKeyJwk())).rejects.toThrow(
      /signature verification failed/,
    );
  });

  it('rejects alg-confusion: a token with alg=none', async () => {
    const signer = await createEphemeralCertificateSigner();
    const pub = await signer.publicKeyJwk();
    // Hand-craft an unsecured (alg:none) token over the same claims.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: ERASURE_CERT_TYP })).toString(
      'base64url',
    );
    const payload = Buffer.from(JSON.stringify({ cert: erasureCertClaims(sampleCert()) })).toString(
      'base64url',
    );
    const noneToken = `${header}.${payload}.`;
    await expect(verifyErasureCertificate(noneToken, pub)).rejects.toThrow();
  });

  it('rejects alg-confusion: an HS256 (symmetric) token signed with the public key bytes', async () => {
    // Classic RS/ES/EdDSA→HMAC confusion: an attacker who knows the public key tries to sign an
    // HS256 token with it. The verifier pins EdDSA, so it must refuse before treating the key as a
    // shared secret.
    const signer = await createEphemeralCertificateSigner();
    const pub = await signer.publicKeyJwk();
    const fakeSecret = new TextEncoder().encode(JSON.stringify(pub));
    const hsToken = await new SignJWT({ cert: erasureCertClaims(sampleCert()) })
      .setProtectedHeader({ alg: 'HS256', typ: ERASURE_CERT_TYP })
      .sign(fakeSecret);
    await expect(verifyErasureCertificate(hsToken, pub)).rejects.toThrow();
  });

  it('rejects a token signed with EdDSA but a non-cert typ header (confused deputy)', async () => {
    const { privateKey, publicKey } = await generateKeyPair(ERASURE_CERT_ALG, {
      extractable: true,
    });
    const pub = await exportJWK(publicKey);
    const jws = await new SignJWT({ cert: erasureCertClaims(sampleCert()) })
      .setProtectedHeader({ alg: ERASURE_CERT_ALG, typ: 'application/some-other+jws' })
      .sign(privateKey);
    await expect(verifyErasureCertificate(jws, pub)).rejects.toThrow(
      /unexpected or missing certificate type/,
    );
  });

  it('rejects a structurally-valid signature over a malformed cert body (missing fields)', async () => {
    const { privateKey, publicKey } = await generateKeyPair(ERASURE_CERT_ALG, {
      extractable: true,
    });
    const pub = await exportJWK(publicKey);
    // Validly signed, with a verification block but missing other required fields (e.g. `slug`,
    // `erasedAt`) and wrong types → reconstruct must reject (no coercion).
    const jws = await new SignJWT({
      cert: { tenantId: 't1', verification: { secretShredded: true, statusDeleted: true } },
    })
      .setProtectedHeader({ alg: ERASURE_CERT_ALG, typ: ERASURE_CERT_TYP })
      .sign(privateKey);
    await expect(verifyErasureCertificate(jws, pub)).rejects.toThrow(/invalid shape/);
  });

  it('rejects a signed token missing the cert claim entirely', async () => {
    const { privateKey, publicKey } = await generateKeyPair(ERASURE_CERT_ALG, {
      extractable: true,
    });
    const pub = await exportJWK(publicKey);
    const jws = await new SignJWT({ notcert: true })
      .setProtectedHeader({ alg: ERASURE_CERT_ALG, typ: ERASURE_CERT_TYP })
      .sign(privateKey);
    await expect(verifyErasureCertificate(jws, pub)).rejects.toThrow(
      /missing the certificate claim/,
    );
  });

  it('rejects an empty / non-string JWS', async () => {
    const signer = await createEphemeralCertificateSigner();
    const pub = await signer.publicKeyJwk();
    await expect(verifyErasureCertificate('', pub)).rejects.toThrow(/empty or non-string/);
  });

  it('rejects a non-Ed25519 public key (wrong kty/crv)', async () => {
    const signer = await createEphemeralCertificateSigner();
    const jws = await signer.sign(sampleCert());
    await expect(
      verifyErasureCertificate(jws, { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' }),
    ).rejects.toThrow(/must be an Ed25519/);
  });

  it('refuses a PRIVATE key where a public one is expected', async () => {
    const { privateKey } = await generateKeyPair(ERASURE_CERT_ALG, { extractable: true });
    const privJwk = await exportJWK(privateKey);
    expect(privJwk.d).toBeDefined();
    const signer = await createEd25519CertificateSigner({ privateKey: privJwk });
    const jws = await signer.sign(sampleCert());
    await expect(verifyErasureCertificate(jws, privJwk)).rejects.toThrow(
      /private material present/,
    );
  });

  it('rejects a non-JWS string (garbage input)', async () => {
    const signer = await createEphemeralCertificateSigner();
    await expect(
      verifyErasureCertificate('not-a-jws', await signer.publicKeyJwk()),
    ).rejects.toThrow();
  });

  it('rejects a validly-signed payload that is not valid JSON', async () => {
    const { privateKey, publicKey } = await generateKeyPair(ERASURE_CERT_ALG, {
      extractable: true,
    });
    const pub = await exportJWK(publicKey);
    const jws = await new CompactSign(new TextEncoder().encode('not json at all'))
      .setProtectedHeader({ alg: ERASURE_CERT_ALG, typ: ERASURE_CERT_TYP })
      .sign(privateKey);
    await expect(verifyErasureCertificate(jws, pub)).rejects.toThrow(/not valid JSON/);
  });

  it('rejects a validly-signed payload whose JSON is not an object (e.g. a number)', async () => {
    const { privateKey, publicKey } = await generateKeyPair(ERASURE_CERT_ALG, {
      extractable: true,
    });
    const pub = await exportJWK(publicKey);
    const jws = await new CompactSign(new TextEncoder().encode('42'))
      .setProtectedHeader({ alg: ERASURE_CERT_ALG, typ: ERASURE_CERT_TYP })
      .sign(privateKey);
    await expect(verifyErasureCertificate(jws, pub)).rejects.toThrow(/payload is not an object/);
  });

  it('rejects a cert claim whose verification block is not an object', async () => {
    const { privateKey, publicKey } = await generateKeyPair(ERASURE_CERT_ALG, {
      extractable: true,
    });
    const pub = await exportJWK(publicKey);
    const jws = await new SignJWT({ cert: { tenantId: 't1', verification: 'nope' } })
      .setProtectedHeader({ alg: ERASURE_CERT_ALG, typ: ERASURE_CERT_TYP })
      .sign(privateKey);
    await expect(verifyErasureCertificate(jws, pub)).rejects.toThrow(
      /malformed verification block/,
    );
  });
});

describe('erasureCertClaims canonicalization', () => {
  it('embeds exactly the public certificate fields under `cert` (no secrets)', () => {
    const claims = erasureCertClaims(sampleCert());
    expect(Object.keys(claims).sort()).toEqual(
      [
        'erasedAt',
        'exportLocation',
        'exported',
        'projectDeleted',
        'reason',
        'slug',
        'tenantId',
        'verification',
        'verified',
      ].sort(),
    );
  });

  it('omits exportLocation when the certificate has none', () => {
    const claims = erasureCertClaims(sampleCert({}, { withExportLocation: false }));
    expect('exportLocation' in claims).toBe(false);
  });

  it('exposes the pinned algorithm constant', () => {
    expect(ERASURE_CERT_ALG).toBe('EdDSA');
  });
});
