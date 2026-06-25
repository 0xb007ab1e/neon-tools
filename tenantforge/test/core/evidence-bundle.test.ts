import { describe, expect, it } from 'vitest';
import { CompactSign, SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import {
  buildEvidenceBundle,
  evidenceBundleClaims,
  verifyEvidenceBundle,
  EVIDENCE_BUNDLE_ALG,
  EVIDENCE_BUNDLE_TYP,
} from '../../src/core/evidence-bundle.js';
import {
  createEd25519EvidenceBundleSigner,
  createEphemeralEvidenceBundleSigner,
  EVIDENCE_BUNDLE_KID,
} from '../../src/adapters/evidence-bundle-signer.js';
import { buildErasureCertificate } from '../../src/core/erasure.js';
import { verifyErasureCertificate } from '../../src/core/erasure-cert.js';
import { createEphemeralCertificateSigner } from '../../src/adapters/certificate-signer.js';
import { createEphemeralComplianceReportSigner } from '../../src/adapters/compliance-report-signer.js';
import { buildComplianceReport } from '../../src/core/compliance.js';
import type { TenantRecord } from '../../src/core/domain.js';
import type { TenantEvent } from '../../src/core/observability.js';

const NOW = new Date('2026-06-25T00:00:00.000Z');

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

const FLEET: TenantRecord[] = [
  tenant(),
  tenant({ id: 't2', slug: 'beta', neonProjectId: 'proj-2' }),
  tenant({ id: 't3', slug: 'gamma', neonProjectId: 'proj-3', region: 'aws-us-east-1' }),
];

const AUDIT: TenantEvent[] = [
  {
    event: 'tenant.transition',
    at: '2026-06-20T00:00:00.000Z',
    outcome: 'ok',
    actor: { id: 'op-1', role: 'admin' },
    tenantId: 't1',
    context: { to: 'deleted' },
  },
  { event: 'tenant.provisioned', at: '2026-06-24T00:00:00.000Z', outcome: 'ok', tenantId: 't2' },
  { event: 'system.health', at: '2026-06-23T00:00:00.000Z', outcome: 'ok' },
];

/** A genuinely signed erasure-certificate JWS for embedding tests. */
async function signedErasureCert(tenantId = 't1'): Promise<{ jws: string; pub: JWK }> {
  const signer = await createEphemeralCertificateSigner();
  const cert = buildErasureCertificate({
    tenant: tenant({ id: tenantId }),
    reason: 'GDPR Art.17',
    erasedAt: '2026-06-20T00:00:00.000Z',
    exported: false,
    projectDeleted: true,
    secretShredded: true,
    statusDeleted: true,
  });
  return { jws: await signer.sign(cert), pub: await signer.publicKeyJwk() };
}

describe('buildEvidenceBundle — assembly (fleet + per-tenant)', () => {
  it('assembles a fleet bundle covering all tenants with per-artifact content hashes', () => {
    const bundle = buildEvidenceBundle(FLEET, {
      scope: 'fleet',
      allowedRegions: ['aws-eu-central-1', 'aws-us-east-1'],
      now: NOW,
      auditExcerpt: AUDIT,
    });
    expect(bundle.scope).toBe('fleet');
    expect('tenantId' in bundle).toBe(false);
    expect(bundle.artifacts.inventory.total).toBe(3);
    expect(bundle.generatedAt).toBe('2026-06-25T00:00:00.000Z');
    // Content hashes present for every artifact (hex sha256 = 64 chars).
    for (const h of Object.values(bundle.contentHashes)) expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('per-tenant bundle contains ONLY that tenant’s artifacts (BOLA scoping)', () => {
    const bundle = buildEvidenceBundle(FLEET, {
      scope: 'tenant',
      tenantId: 't2',
      allowedRegions: ['aws-eu-central-1', 'aws-us-east-1'],
      now: NOW,
      auditExcerpt: AUDIT,
    });
    expect(bundle.scope).toBe('tenant');
    expect(bundle.tenantId).toBe('t2');
    // Inventory counts ONLY t2 (one active tenant), never the whole fleet.
    expect(bundle.artifacts.inventory.total).toBe(1);
    expect(bundle.artifacts.inventory.byStatus.active).toBe(1);
    // Residency byJurisdiction reflects only t2's region.
    expect(
      Object.values(bundle.artifacts.residency.byJurisdiction).reduce((a, b) => a + b, 0),
    ).toBe(1);
    // Audit excerpt filtered to t2 — t1's and the fleet-level event are absent.
    expect(bundle.artifacts.auditExcerpt.every((e) => e.tenantId === 't2')).toBe(true);
    expect(bundle.artifacts.auditExcerpt.length).toBe(1);
  });

  it('per-tenant scoping never leaks tenant A’s facts into tenant B’s bundle', () => {
    const a = buildEvidenceBundle(FLEET, {
      scope: 'tenant',
      tenantId: 't1',
      now: NOW,
      auditExcerpt: AUDIT,
    });
    const b = buildEvidenceBundle(FLEET, {
      scope: 'tenant',
      tenantId: 't3',
      now: NOW,
      auditExcerpt: AUDIT,
    });
    // A's isolation only references A's project; B's only B's. No cross-tenant id appears.
    const aSerialized = JSON.stringify(a);
    expect(aSerialized).not.toMatch(/"proj-3"|"gamma"|"t3"/);
    const bSerialized = JSON.stringify(b);
    expect(bSerialized).not.toMatch(/"proj-1"|"acme"|"t1"/);
  });

  it('omits the audit excerpt array as empty when no audit excerpt is provided', () => {
    const bundle = buildEvidenceBundle(FLEET, { scope: 'fleet', now: NOW });
    expect(bundle.artifacts.auditExcerpt).toEqual([]);
    expect(bundle.artifacts.erasureCertificates).toEqual([]);
  });

  it('folds in already-signed erasure-cert JWS strings verbatim (opaque, not re-signed)', async () => {
    const { jws } = await signedErasureCert();
    const bundle = buildEvidenceBundle(FLEET, {
      scope: 'fleet',
      now: NOW,
      erasureCertificates: [jws],
    });
    expect(bundle.artifacts.erasureCertificates).toEqual([jws]);
  });

  it('detects a shared-project isolation violation in a fleet bundle', () => {
    const shared = [tenant(), tenant({ id: 't2', slug: 'beta' /* same proj-1 */ })];
    const bundle = buildEvidenceBundle(shared, { scope: 'fleet', now: NOW });
    expect(bundle.artifacts.isolation.compliant).toBe(false);
    expect(bundle.artifacts.isolation.sharedProjects.length).toBeGreaterThan(0);
  });

  it('isolation/residency attestations match buildComplianceReport for the fleet (shared builders)', () => {
    const bundle = buildEvidenceBundle(FLEET, {
      scope: 'fleet',
      allowedRegions: ['aws-eu-central-1'],
      now: NOW,
    });
    const report = buildComplianceReport(FLEET, {
      allowedRegions: ['aws-eu-central-1'],
      now: NOW,
    });
    expect(bundle.artifacts.isolation).toEqual(report.isolation);
    expect(bundle.artifacts.residency).toEqual(report.residency);
    expect(bundle.artifacts.inventory).toEqual(report.inventory);
  });
});

describe('buildEvidenceBundle — scope/tenant pairing fails closed', () => {
  it('throws when scope=tenant without a tenantId', () => {
    expect(() => buildEvidenceBundle(FLEET, { scope: 'tenant', now: NOW })).toThrow(
      /requires a non-empty tenantId/,
    );
  });

  it('throws when scope=tenant with an empty tenantId', () => {
    expect(() => buildEvidenceBundle(FLEET, { scope: 'tenant', tenantId: '', now: NOW })).toThrow(
      /requires a non-empty tenantId/,
    );
  });

  it('throws when the scoped tenant is not in the registry (no misleading all-clear)', () => {
    expect(() =>
      buildEvidenceBundle(FLEET, { scope: 'tenant', tenantId: 'ghost', now: NOW }),
    ).toThrow(/not present in the registry/);
  });

  it('throws when scope=fleet is given a tenantId', () => {
    expect(() => buildEvidenceBundle(FLEET, { scope: 'fleet', tenantId: 't1', now: NOW })).toThrow(
      /must not be given a tenantId/,
    );
  });
});

describe('evidence-bundle sign → verify round-trip', () => {
  it('round-trips a fleet bundle to the identical bundle (ephemeral key)', async () => {
    const signer = await createEphemeralEvidenceBundleSigner();
    const bundle = buildEvidenceBundle(FLEET, {
      scope: 'fleet',
      allowedRegions: ['aws-eu-central-1', 'aws-us-east-1'],
      now: NOW,
      auditExcerpt: AUDIT,
    });
    const jws = await signer.signBundle(bundle);
    await expect(verifyEvidenceBundle(jws, await signer.publicKeyJwk())).resolves.toEqual(bundle);
  });

  it('round-trips a per-tenant bundle (with embedded erasure cert) to the identical bundle', async () => {
    const signer = await createEphemeralEvidenceBundleSigner();
    const { jws: certJws } = await signedErasureCert('t2');
    const bundle = buildEvidenceBundle(FLEET, {
      scope: 'tenant',
      tenantId: 't2',
      allowedRegions: ['aws-eu-central-1', 'aws-us-east-1'],
      now: NOW,
      auditExcerpt: AUDIT,
      erasureCertificates: [certJws],
    });
    const jws = await signer.signBundle(bundle);
    const verified = await verifyEvidenceBundle(jws, await signer.publicKeyJwk());
    expect(verified).toEqual(bundle);
    expect(verified.tenantId).toBe('t2');
  });

  it('round-trips a fleet bundle WITH shared-project + residency violations (reconstructs both)', async () => {
    // Two tenants sharing one project (isolation violation) + an unknown-region tenant (residency
    // violation) populate both `sharedProjects` and `violations`, exercising their map-success
    // reconstruction branches on verify.
    const signer = await createEphemeralEvidenceBundleSigner();
    const violators: TenantRecord[] = [
      tenant(),
      tenant({ id: 't2', slug: 'beta' /* same proj-1 */ }),
      tenant({ id: 't3', slug: 'gamma', neonProjectId: 'proj-3', region: 'made-up-region' }),
    ];
    const bundle = buildEvidenceBundle(violators, { scope: 'fleet', allowedRegions: [], now: NOW });
    expect(bundle.artifacts.isolation.sharedProjects.length).toBeGreaterThan(0);
    expect(bundle.artifacts.residency.violations.length).toBeGreaterThan(0);
    const jws = await signer.signBundle(bundle);
    await expect(verifyEvidenceBundle(jws, await signer.publicKeyJwk())).resolves.toEqual(bundle);
  });

  it('round-trips a fleet bundle with no audit excerpt and no certs', async () => {
    const signer = await createEphemeralEvidenceBundleSigner();
    const bundle = buildEvidenceBundle(FLEET, { scope: 'fleet', now: NOW });
    const jws = await signer.signBundle(bundle);
    await expect(verifyEvidenceBundle(jws, await signer.publicKeyJwk())).resolves.toEqual(bundle);
  });

  it('round-trips a configured (PEM/JWK) signer the same as ephemeral', async () => {
    const { privateKey } = await generateKeyPair(EVIDENCE_BUNDLE_ALG, { extractable: true });
    const privJwk = await exportJWK(privateKey);
    const signer = await createEd25519EvidenceBundleSigner({ privateKey: privJwk });
    const bundle = buildEvidenceBundle(FLEET, { scope: 'fleet', now: NOW, auditExcerpt: AUDIT });
    const jws = await signer.signBundle(bundle);
    await expect(verifyEvidenceBundle(jws, await signer.publicKeyJwk())).resolves.toEqual(bundle);
  });

  it('the protected header pins alg=EdDSA, the domain typ, and the evidence-bundle kid', async () => {
    const signer = await createEphemeralEvidenceBundleSigner();
    const jws = await signer.signBundle(buildEvidenceBundle(FLEET, { scope: 'fleet', now: NOW }));
    const header = JSON.parse(Buffer.from(jws.split('.')[0]!, 'base64url').toString('utf8'));
    expect(header.alg).toBe('EdDSA');
    expect(header.typ).toBe(EVIDENCE_BUNDLE_TYP);
    expect(header.kid).toBe(EVIDENCE_BUNDLE_KID);
  });
});

describe('embedded erasure certificate — independent verification + tamper detection', () => {
  it('an embedded erasure-cert JWS still verifies independently via verifyErasureCertificate', async () => {
    const bundleSigner = await createEphemeralEvidenceBundleSigner();
    const { jws: certJws, pub: certPub } = await signedErasureCert('t1');
    const bundle = buildEvidenceBundle(FLEET, {
      scope: 'tenant',
      tenantId: 't1',
      now: NOW,
      erasureCertificates: [certJws],
    });
    const bundleJws = await bundleSigner.signBundle(bundle);
    const verifiedBundle = await verifyEvidenceBundle(bundleJws, await bundleSigner.publicKeyJwk());
    // The nested cert survives the round-trip verbatim and verifies on its own with the ERASURE key.
    const nested = verifiedBundle.artifacts.erasureCertificates[0]!;
    const cert = await verifyErasureCertificate(nested, certPub);
    expect(cert.tenantId).toBe('t1');
    expect(cert.verified).toBe(true);
  });

  it('a TAMPERED embedded erasure cert breaks the bundle signature (detectable)', async () => {
    const bundleSigner = await createEphemeralEvidenceBundleSigner();
    const { jws: certJws } = await signedErasureCert('t1');
    const bundle = buildEvidenceBundle(FLEET, {
      scope: 'tenant',
      tenantId: 't1',
      now: NOW,
      erasureCertificates: [certJws],
    });
    const bundleJws = await bundleSigner.signBundle(bundle);
    // Re-sign nothing: forge the payload to swap the embedded cert, keep the bundle signature.
    const [h, , s] = bundleJws.split('.');
    const { jws: otherCert } = await signedErasureCert('t2');
    const forged = { ...evidenceBundleClaims(bundle) } as Record<string, unknown>;
    (forged.artifacts as { erasureCertificates: string[] }).erasureCertificates = [otherCert];
    const payload = Buffer.from(JSON.stringify({ bundle: forged })).toString('base64url');
    const tampered = `${h}.${payload}.${s}`;
    await expect(verifyEvidenceBundle(tampered, await bundleSigner.publicKeyJwk())).rejects.toThrow(
      /signature verification failed/,
    );
  });
});

describe('evidence-bundle verify — abuse / fail-closed (untrusted input)', () => {
  it('rejects a TAMPERED payload (signature no longer matches)', async () => {
    const signer = await createEphemeralEvidenceBundleSigner();
    const bundle = buildEvidenceBundle(FLEET, { scope: 'fleet', now: NOW, auditExcerpt: AUDIT });
    const jws = await signer.signBundle(bundle);
    const [h, , s] = jws.split('.');
    const forged = buildEvidenceBundle([tenant({ region: 'made-up' })], {
      scope: 'fleet',
      now: NOW,
    });
    const payload = Buffer.from(JSON.stringify({ bundle: evidenceBundleClaims(forged) })).toString(
      'base64url',
    );
    await expect(
      verifyEvidenceBundle(`${h}.${payload}.${s}`, await signer.publicKeyJwk()),
    ).rejects.toThrow(/signature verification failed/);
  });

  it('rejects verification with the WRONG public key (different keypair)', async () => {
    const signer = await createEphemeralEvidenceBundleSigner();
    const other = await createEphemeralEvidenceBundleSigner();
    const jws = await signer.signBundle(buildEvidenceBundle(FLEET, { scope: 'fleet', now: NOW }));
    await expect(verifyEvidenceBundle(jws, await other.publicKeyJwk())).rejects.toThrow(
      /signature verification failed/,
    );
  });

  it('rejects alg-confusion: a token with alg=none', async () => {
    const signer = await createEphemeralEvidenceBundleSigner();
    const pub = await signer.publicKeyJwk();
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: EVIDENCE_BUNDLE_TYP })).toString(
      'base64url',
    );
    const payload = Buffer.from(
      JSON.stringify({
        bundle: evidenceBundleClaims(buildEvidenceBundle(FLEET, { scope: 'fleet', now: NOW })),
      }),
    ).toString('base64url');
    await expect(verifyEvidenceBundle(`${header}.${payload}.`, pub)).rejects.toThrow();
  });

  it('rejects alg-confusion: an HS256 token signed with the public key bytes', async () => {
    const signer = await createEphemeralEvidenceBundleSigner();
    const pub = await signer.publicKeyJwk();
    const fakeSecret = new TextEncoder().encode(JSON.stringify(pub));
    const hsToken = await new SignJWT({
      bundle: evidenceBundleClaims(buildEvidenceBundle(FLEET, { scope: 'fleet', now: NOW })),
    })
      .setProtectedHeader({ alg: 'HS256', typ: EVIDENCE_BUNDLE_TYP })
      .sign(fakeSecret);
    await expect(verifyEvidenceBundle(hsToken, pub)).rejects.toThrow();
  });

  it('rejects a token signed with EdDSA but a non-bundle typ header (confused deputy)', async () => {
    const { privateKey, publicKey } = await generateKeyPair(EVIDENCE_BUNDLE_ALG, {
      extractable: true,
    });
    const pub = await exportJWK(publicKey);
    const jws = await new SignJWT({
      bundle: evidenceBundleClaims(buildEvidenceBundle(FLEET, { scope: 'fleet', now: NOW })),
    })
      .setProtectedHeader({ alg: EVIDENCE_BUNDLE_ALG, typ: 'application/some-other+jws' })
      .sign(privateKey);
    await expect(verifyEvidenceBundle(jws, pub)).rejects.toThrow(
      /unexpected or missing evidence-bundle type/,
    );
  });

  it('CROSS-TYPE: a compliance-report JWS does NOT verify as an evidence bundle', async () => {
    // A real compliance-report signer + verifier pair presented to the bundle verifier is rejected
    // (the report signer pins the compliance typ — ADR-0011 / std-cwe cross-type confusion).
    const reportSigner = await createEphemeralComplianceReportSigner();
    const report = buildComplianceReport(FLEET, { allowedRegions: ['aws-eu-central-1'], now: NOW });
    const reportJws = await reportSigner.signReport(report);
    await expect(
      verifyEvidenceBundle(reportJws, await reportSigner.publicKeyJwk()),
    ).rejects.toThrow(/unexpected or missing evidence-bundle type/);
  });

  it('CROSS-TYPE: an erasure-certificate JWS does NOT verify as an evidence bundle', async () => {
    const { jws, pub } = await signedErasureCert('t1');
    await expect(verifyEvidenceBundle(jws, pub)).rejects.toThrow(
      /unexpected or missing evidence-bundle type/,
    );
  });

  it('CROSS-TYPE: a bundle JWS does NOT verify as a compliance report or erasure cert', async () => {
    // The reverse direction: a genuinely-signed evidence bundle must be rejected by BOTH the
    // compliance-report verifier and the erasure-cert verifier (the distinct typ per artifact class).
    const { verifyComplianceReport } = await import('../../src/core/compliance-cert.js');
    const signer = await createEphemeralEvidenceBundleSigner();
    const bundleJws = await signer.signBundle(
      buildEvidenceBundle(FLEET, { scope: 'fleet', now: NOW }),
    );
    const pub = await signer.publicKeyJwk();
    await expect(verifyComplianceReport(bundleJws, pub)).rejects.toThrow(
      /unexpected or missing compliance-report type/,
    );
    await expect(verifyErasureCertificate(bundleJws, pub)).rejects.toThrow(
      /unexpected or missing certificate type/,
    );
  });

  it('rejects an empty / non-string JWS', async () => {
    const signer = await createEphemeralEvidenceBundleSigner();
    await expect(verifyEvidenceBundle('', await signer.publicKeyJwk())).rejects.toThrow(
      /empty or non-string/,
    );
  });

  it('rejects a non-Ed25519 public key (wrong kty/crv)', async () => {
    const signer = await createEphemeralEvidenceBundleSigner();
    const jws = await signer.signBundle(buildEvidenceBundle(FLEET, { scope: 'fleet', now: NOW }));
    await expect(
      verifyEvidenceBundle(jws, { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' }),
    ).rejects.toThrow(/must be an Ed25519/);
  });

  it('refuses a PRIVATE key where a public one is expected', async () => {
    const { privateKey } = await generateKeyPair(EVIDENCE_BUNDLE_ALG, { extractable: true });
    const privJwk = await exportJWK(privateKey);
    expect(privJwk.d).toBeDefined();
    const signer = await createEd25519EvidenceBundleSigner({ privateKey: privJwk });
    const jws = await signer.signBundle(buildEvidenceBundle(FLEET, { scope: 'fleet', now: NOW }));
    await expect(verifyEvidenceBundle(jws, privJwk)).rejects.toThrow(/private material present/);
  });

  it('rejects a non-JWS string (garbage input)', async () => {
    const signer = await createEphemeralEvidenceBundleSigner();
    await expect(verifyEvidenceBundle('not-a-jws', await signer.publicKeyJwk())).rejects.toThrow();
  });

  it('rejects a validly-signed payload that is not valid JSON', async () => {
    const { privateKey, publicKey } = await generateKeyPair(EVIDENCE_BUNDLE_ALG, {
      extractable: true,
    });
    const pub = await exportJWK(publicKey);
    const jws = await new CompactSign(new TextEncoder().encode('not json at all'))
      .setProtectedHeader({ alg: EVIDENCE_BUNDLE_ALG, typ: EVIDENCE_BUNDLE_TYP })
      .sign(privateKey);
    await expect(verifyEvidenceBundle(jws, pub)).rejects.toThrow(/not valid JSON/);
  });

  it('rejects a validly-signed payload whose JSON is not an object (e.g. a number)', async () => {
    const { privateKey, publicKey } = await generateKeyPair(EVIDENCE_BUNDLE_ALG, {
      extractable: true,
    });
    const pub = await exportJWK(publicKey);
    const jws = await new CompactSign(new TextEncoder().encode('42'))
      .setProtectedHeader({ alg: EVIDENCE_BUNDLE_ALG, typ: EVIDENCE_BUNDLE_TYP })
      .sign(privateKey);
    await expect(verifyEvidenceBundle(jws, pub)).rejects.toThrow(/payload is not an object/);
  });

  it('rejects a payload missing the bundle claim entirely', async () => {
    const { privateKey, publicKey } = await generateKeyPair(EVIDENCE_BUNDLE_ALG, {
      extractable: true,
    });
    const pub = await exportJWK(publicKey);
    const jws = await new SignJWT({ notbundle: true })
      .setProtectedHeader({ alg: EVIDENCE_BUNDLE_ALG, typ: EVIDENCE_BUNDLE_TYP })
      .sign(privateKey);
    await expect(verifyEvidenceBundle(jws, pub)).rejects.toThrow(/missing the bundle claim/);
  });
});

describe('evidence-bundle verify — every shape guard fails closed (allow-list reconstruction)', () => {
  // Sign an arbitrary (deliberately malformed) claims body with a valid EdDSA key + the correct typ,
  // so the signature and type gates PASS and the reconstruction shape guards are what reject it.
  async function signMalformed(
    mutate: (claims: Record<string, unknown>) => void,
  ): Promise<{ jws: string; pub: JWK }> {
    const { privateKey, publicKey } = await generateKeyPair(EVIDENCE_BUNDLE_ALG, {
      extractable: true,
    });
    const pub = await exportJWK(publicKey);
    const claims = evidenceBundleClaims(
      buildEvidenceBundle(FLEET, {
        scope: 'tenant',
        tenantId: 't2',
        allowedRegions: ['aws-eu-central-1'],
        now: NOW,
        auditExcerpt: AUDIT,
        erasureCertificates: ['x.y.z'],
      }),
    );
    mutate(claims);
    const jws = await new SignJWT({ bundle: claims })
      .setProtectedHeader({ alg: EVIDENCE_BUNDLE_ALG, typ: EVIDENCE_BUNDLE_TYP })
      .sign(privateKey);
    return { jws, pub };
  }

  it('rejects a bundle with an invalid scope', async () => {
    const { jws, pub } = await signMalformed((c) => {
      c.scope = 'galaxy';
    });
    await expect(verifyEvidenceBundle(jws, pub)).rejects.toThrow(/bundle has an invalid shape/);
  });

  it('rejects a bundle with a non-string generatedAt', async () => {
    const { jws, pub } = await signMalformed((c) => {
      c.generatedAt = 42;
    });
    await expect(verifyEvidenceBundle(jws, pub)).rejects.toThrow(/bundle has an invalid shape/);
  });

  it('rejects a tenant-scoped bundle missing the tenantId', async () => {
    const { jws, pub } = await signMalformed((c) => {
      delete c.tenantId;
    });
    await expect(verifyEvidenceBundle(jws, pub)).rejects.toThrow(/missing a string tenantId/);
  });

  it('rejects a tenant-scoped bundle with a non-string tenantId', async () => {
    const { jws, pub } = await signMalformed((c) => {
      c.tenantId = 42;
    });
    await expect(verifyEvidenceBundle(jws, pub)).rejects.toThrow(/missing a string tenantId/);
  });

  it('rejects a FLEET-scoped bundle that carries a tenantId (forged narrowing)', async () => {
    const { privateKey, publicKey } = await generateKeyPair(EVIDENCE_BUNDLE_ALG, {
      extractable: true,
    });
    const pub = await exportJWK(publicKey);
    const claims = evidenceBundleClaims(buildEvidenceBundle(FLEET, { scope: 'fleet', now: NOW }));
    claims.tenantId = 'sneaky';
    const jws = await new SignJWT({ bundle: claims })
      .setProtectedHeader({ alg: EVIDENCE_BUNDLE_ALG, typ: EVIDENCE_BUNDLE_TYP })
      .sign(privateKey);
    await expect(verifyEvidenceBundle(jws, pub)).rejects.toThrow(/must not carry a tenantId/);
  });

  it('rejects a non-object artifacts block', async () => {
    const { jws, pub } = await signMalformed((c) => {
      c.artifacts = 42;
    });
    await expect(verifyEvidenceBundle(jws, pub)).rejects.toThrow(/malformed artifacts block/);
  });

  it('rejects erasureCertificates that are not a string array', async () => {
    const { jws, pub } = await signMalformed((c) => {
      (c.artifacts as { erasureCertificates: unknown }).erasureCertificates = [42];
    });
    await expect(verifyEvidenceBundle(jws, pub)).rejects.toThrow(/malformed erasureCertificates/);
  });

  it('rejects a non-object inventory block', async () => {
    const { jws, pub } = await signMalformed((c) => {
      (c.artifacts as { inventory: unknown }).inventory = 42;
    });
    await expect(verifyEvidenceBundle(jws, pub)).rejects.toThrow(/malformed inventory block/);
  });

  it('rejects a malformed inventory block (negative total)', async () => {
    const { jws, pub } = await signMalformed((c) => {
      (c.artifacts as { inventory: unknown }).inventory = { total: -1, byStatus: {} };
    });
    await expect(verifyEvidenceBundle(jws, pub)).rejects.toThrow(/malformed inventory block/);
  });

  it('rejects an inventory byStatus with unexpected/missing status keys', async () => {
    const { jws, pub } = await signMalformed((c) => {
      (c.artifacts as { inventory: unknown }).inventory = {
        total: 1,
        byStatus: { active: 1 },
      };
    });
    await expect(verifyEvidenceBundle(jws, pub)).rejects.toThrow(/byStatus has unexpected keys/);
  });

  it('rejects an inventory byStatus with a non-integer count', async () => {
    const { jws, pub } = await signMalformed((c) => {
      (c.artifacts as { inventory: { byStatus: Record<string, unknown> } }).inventory.byStatus = {
        provisioning: 0,
        active: 1.5,
        suspended: 0,
        offboarding: 0,
        deleted: 0,
      };
    });
    await expect(verifyEvidenceBundle(jws, pub)).rejects.toThrow(/byStatus has an invalid count/);
  });

  it('rejects a non-object isolation block', async () => {
    const { jws, pub } = await signMalformed((c) => {
      (c.artifacts as { isolation: unknown }).isolation = 42;
    });
    await expect(verifyEvidenceBundle(jws, pub)).rejects.toThrow(/malformed isolation block/);
  });

  it('rejects an isolation block with a non-boolean compliant flag', async () => {
    const { jws, pub } = await signMalformed((c) => {
      (c.artifacts as { isolation: unknown }).isolation = {
        compliant: 'yes',
        missingProject: [],
        sharedProjects: [],
      };
    });
    await expect(verifyEvidenceBundle(jws, pub)).rejects.toThrow(/malformed isolation block/);
  });

  it('rejects a non-object sharedProjects entry', async () => {
    const { jws, pub } = await signMalformed((c) => {
      (c.artifacts as { isolation: { sharedProjects: unknown[] } }).isolation.sharedProjects = [42];
    });
    await expect(verifyEvidenceBundle(jws, pub)).rejects.toThrow(/malformed sharedProjects entry/);
  });

  it('rejects a sharedProjects entry with mistyped fields', async () => {
    const { jws, pub } = await signMalformed((c) => {
      (c.artifacts as { isolation: { sharedProjects: unknown[] } }).isolation.sharedProjects = [
        { neonProjectId: 1, tenantIds: ['t1'] },
      ];
    });
    await expect(verifyEvidenceBundle(jws, pub)).rejects.toThrow(/malformed sharedProjects entry/);
  });

  it('rejects a non-object residency block', async () => {
    const { jws, pub } = await signMalformed((c) => {
      (c.artifacts as { residency: unknown }).residency = 42;
    });
    await expect(verifyEvidenceBundle(jws, pub)).rejects.toThrow(/malformed residency block/);
  });

  it('rejects a residency block with a non-array allowedRegions', async () => {
    const { jws, pub } = await signMalformed((c) => {
      (c.artifacts as { residency: Record<string, unknown> }).residency = {
        compliant: true,
        allowedRegions: 'nope',
        byJurisdiction: {},
        violations: [],
      };
    });
    await expect(verifyEvidenceBundle(jws, pub)).rejects.toThrow(/malformed residency block/);
  });

  it('rejects a residency byJurisdiction with an invalid count', async () => {
    const { jws, pub } = await signMalformed((c) => {
      (c.artifacts as { residency: { byJurisdiction: unknown } }).residency.byJurisdiction = {
        EU: -3,
      };
    });
    await expect(verifyEvidenceBundle(jws, pub)).rejects.toThrow(
      /byJurisdiction has an invalid count/,
    );
  });

  it('rejects a non-object residency violation', async () => {
    const { jws, pub } = await signMalformed((c) => {
      (c.artifacts as { residency: { violations: unknown[] } }).residency.violations = [42];
    });
    await expect(verifyEvidenceBundle(jws, pub)).rejects.toThrow(/malformed residency violation/);
  });

  it('rejects a residency violation with missing/mistyped fields', async () => {
    const { jws, pub } = await signMalformed((c) => {
      (c.artifacts as { residency: { violations: unknown[] } }).residency.violations = [
        { tenantId: 't1', region: 'r' },
      ];
    });
    await expect(verifyEvidenceBundle(jws, pub)).rejects.toThrow(/malformed residency violation/);
  });

  it('rejects a non-array auditExcerpt', async () => {
    const { jws, pub } = await signMalformed((c) => {
      (c.artifacts as { auditExcerpt: unknown }).auditExcerpt = 'nope';
    });
    await expect(verifyEvidenceBundle(jws, pub)).rejects.toThrow(/malformed auditExcerpt/);
  });

  it('rejects a non-object audit entry', async () => {
    const { jws, pub } = await signMalformed((c) => {
      (c.artifacts as { auditExcerpt: unknown[] }).auditExcerpt = [42];
    });
    await expect(verifyEvidenceBundle(jws, pub)).rejects.toThrow(/malformed audit entry/);
  });

  it('rejects an audit entry missing required at/event', async () => {
    const { jws, pub } = await signMalformed((c) => {
      (c.artifacts as { auditExcerpt: unknown[] }).auditExcerpt = [{ event: 'x', outcome: 'ok' }];
    });
    await expect(verifyEvidenceBundle(jws, pub)).rejects.toThrow(/malformed audit entry/);
  });

  it('rejects an audit entry with a bad outcome', async () => {
    const { jws, pub } = await signMalformed((c) => {
      (c.artifacts as { auditExcerpt: unknown[] }).auditExcerpt = [
        { at: '2026-06-24T00:00:00.000Z', event: 'x', outcome: 'maybe' },
      ];
    });
    await expect(verifyEvidenceBundle(jws, pub)).rejects.toThrow(/malformed audit entry/);
  });

  it('rejects an audit entry whose actor is not an object', async () => {
    const { jws, pub } = await signMalformed((c) => {
      (c.artifacts as { auditExcerpt: unknown[] }).auditExcerpt = [
        { at: '2026-06-24T00:00:00.000Z', event: 'x', outcome: 'ok', actor: 42 },
      ];
    });
    await expect(verifyEvidenceBundle(jws, pub)).rejects.toThrow(/malformed audit entry actor/);
  });

  it('rejects an audit entry whose actor has mistyped id/role', async () => {
    const { jws, pub } = await signMalformed((c) => {
      (c.artifacts as { auditExcerpt: unknown[] }).auditExcerpt = [
        { at: '2026-06-24T00:00:00.000Z', event: 'x', outcome: 'ok', actor: { id: 1, role: 'r' } },
      ];
    });
    await expect(verifyEvidenceBundle(jws, pub)).rejects.toThrow(/malformed audit entry actor/);
  });

  it('rejects an audit entry whose tenantId is present but not a string', async () => {
    const { jws, pub } = await signMalformed((c) => {
      (c.artifacts as { auditExcerpt: unknown[] }).auditExcerpt = [
        { at: '2026-06-24T00:00:00.000Z', event: 'x', outcome: 'ok', tenantId: 42 },
      ];
    });
    await expect(verifyEvidenceBundle(jws, pub)).rejects.toThrow(/malformed audit entry tenantId/);
  });

  it('rejects a non-object contentHashes block', async () => {
    const { jws, pub } = await signMalformed((c) => {
      c.contentHashes = 42;
    });
    await expect(verifyEvidenceBundle(jws, pub)).rejects.toThrow(/malformed contentHashes block/);
  });

  it('rejects a contentHashes block with a non-string hash', async () => {
    const { jws, pub } = await signMalformed((c) => {
      (c.contentHashes as Record<string, unknown>).inventory = 42;
    });
    await expect(verifyEvidenceBundle(jws, pub)).rejects.toThrow(/malformed contentHashes block/);
  });
});

describe('evidenceBundleClaims canonicalization', () => {
  it('carries attestation facts only — no secrets / connection URIs', () => {
    const bundle = buildEvidenceBundle(FLEET, {
      scope: 'tenant',
      tenantId: 't2',
      now: NOW,
      auditExcerpt: AUDIT,
    });
    const serialized = JSON.stringify(evidenceBundleClaims(bundle));
    expect(serialized).not.toMatch(/connection|postgres:\/\/|password|secret/i);
  });

  it('embeds erasure-cert JWS strings verbatim under artifacts.erasureCertificates', async () => {
    const { jws } = await signedErasureCert('t1');
    const bundle = buildEvidenceBundle(FLEET, {
      scope: 'fleet',
      now: NOW,
      erasureCertificates: [jws],
    });
    const claims = evidenceBundleClaims(bundle);
    expect((claims.artifacts as { erasureCertificates: string[] }).erasureCertificates).toEqual([
      jws,
    ]);
  });

  it('omits the top-level tenantId for a fleet bundle', () => {
    const claims = evidenceBundleClaims(buildEvidenceBundle(FLEET, { scope: 'fleet', now: NOW }));
    expect('tenantId' in claims).toBe(false);
  });

  it('exposes the pinned algorithm + typ constants', () => {
    expect(EVIDENCE_BUNDLE_ALG).toBe('EdDSA');
    expect(EVIDENCE_BUNDLE_TYP).toBe('application/evidence-bundle+jws');
  });
});
