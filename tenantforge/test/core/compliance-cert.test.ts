import { describe, expect, it } from 'vitest';
import { CompactSign, SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { buildComplianceReport, type ComplianceReport } from '../../src/core/compliance.js';
import {
  verifyComplianceReport,
  complianceReportClaims,
  COMPLIANCE_REPORT_ALG,
  COMPLIANCE_REPORT_TYP,
} from '../../src/core/compliance-cert.js';
import {
  createEd25519ComplianceReportSigner,
  createEphemeralComplianceReportSigner,
} from '../../src/adapters/compliance-report-signer.js';
import { createEphemeralCertificateSigner } from '../../src/adapters/certificate-signer.js';
import { buildErasureCertificate } from '../../src/core/erasure.js';
import { erasureCertClaims, ERASURE_CERT_TYP } from '../../src/core/erasure-cert.js';
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

/** A compliant report with audit (exercises every block — inventory, isolation, residency, audit). */
function sampleReport(overrides: Partial<ComplianceReport> = {}): ComplianceReport {
  const base = buildComplianceReport(
    [tenant(), tenant({ id: 't2', slug: 'beta', neonProjectId: 'proj-2' })],
    {
      allowedRegions: ['aws-eu-central-1'],
      now: new Date('2026-06-25T00:00:00.000Z'),
      audit: {
        erasures: [
          {
            event: 'tenant.transition',
            at: '2026-06-20T00:00:00.000Z',
            outcome: 'ok',
            actor: { id: 'op-1', role: 'admin' },
            tenantId: 'gone-1',
            context: { to: 'deleted' },
          },
        ],
        recent: [
          {
            event: 'tenant.provisioned',
            at: '2026-06-24T00:00:00.000Z',
            outcome: 'ok',
            tenantId: 't1',
          },
        ],
      },
    },
  );
  return { ...base, ...overrides };
}

/** A minimal report with violations + no audit section (the other branch of the shape). */
function violatingReport(): ComplianceReport {
  return buildComplianceReport([tenant({ region: 'made-up-region' })], {
    allowedRegions: [],
    now: new Date('2026-06-25T00:00:00.000Z'),
  });
}

describe('compliance-report sign → verify round-trip', () => {
  it('signs a report and verifies it back to the identical report (ephemeral key)', async () => {
    const signer = await createEphemeralComplianceReportSigner();
    const report = sampleReport();
    const jws = await signer.signReport(report);
    const pub = await signer.publicKeyJwk();
    await expect(verifyComplianceReport(jws, pub)).resolves.toEqual(report);
  });

  it('round-trips a report with a shared-project isolation violation', async () => {
    // Two tenants sharing one Neon project => isolation.sharedProjects has an entry (the cross-tenant
    // breach signal). Exercises the sharedProjects reconstruction path on verify.
    const signer = await createEphemeralComplianceReportSigner();
    const report = buildComplianceReport(
      [tenant(), tenant({ id: 't2', slug: 'beta' /* same neonProjectId 'proj-1' */ })],
      { allowedRegions: ['aws-eu-central-1'], now: new Date('2026-06-25T00:00:00.000Z') },
    );
    expect(report.isolation.compliant).toBe(false);
    expect(report.isolation.sharedProjects.length).toBeGreaterThan(0);
    const jws = await signer.signReport(report);
    await expect(verifyComplianceReport(jws, await signer.publicKeyJwk())).resolves.toEqual(report);
  });

  it('round-trips a report whose audit entries omit actor and tenantId', async () => {
    // A bare audit entry (no actor, no tenantId) exercises the omitted-optional branch on both the
    // claim projection and the reconstruction — fields appear only when present.
    const signer = await createEphemeralComplianceReportSigner();
    const report = buildComplianceReport([tenant()], {
      allowedRegions: ['aws-eu-central-1'],
      now: new Date('2026-06-25T00:00:00.000Z'),
      audit: {
        erasures: [],
        recent: [{ event: 'system.health', at: '2026-06-24T00:00:00.000Z', outcome: 'ok' }],
      },
    });
    expect(report.audit?.recent[0]?.tenantId).toBeUndefined();
    expect(report.audit?.recent[0]?.actor).toBeUndefined();
    const jws = await signer.signReport(report);
    const verified = await verifyComplianceReport(jws, await signer.publicKeyJwk());
    expect(verified).toEqual(report);
    expect('tenantId' in verified.audit!.recent[0]!).toBe(false);
  });

  it('round-trips a report with no audit section and residency violations', async () => {
    const signer = await createEphemeralComplianceReportSigner();
    const report = violatingReport();
    expect(report.audit).toBeUndefined();
    expect(report.residency.compliant).toBe(false);
    const jws = await signer.signReport(report);
    const verified = await verifyComplianceReport(jws, await signer.publicKeyJwk());
    expect(verified).toEqual(report);
    expect('audit' in verified).toBe(false);
  });

  it('round-trips a configured (PEM/JWK) signer the same as ephemeral', async () => {
    const { privateKey } = await generateKeyPair(COMPLIANCE_REPORT_ALG, { extractable: true });
    const privJwk = await exportJWK(privateKey);
    const signer = await createEd25519ComplianceReportSigner({ privateKey: privJwk });
    const report = sampleReport();
    const jws = await signer.signReport(report);
    await expect(verifyComplianceReport(jws, await signer.publicKeyJwk())).resolves.toEqual(report);
  });

  it('the protected header pins alg=EdDSA, the domain typ, and the compliance kid', async () => {
    const signer = await createEphemeralComplianceReportSigner();
    const jws = await signer.signReport(sampleReport());
    const header = JSON.parse(Buffer.from(jws.split('.')[0]!, 'base64url').toString('utf8'));
    expect(header.alg).toBe('EdDSA');
    expect(header.typ).toBe(COMPLIANCE_REPORT_TYP);
    expect(header.kid).toBe('tenantforge-compliance-report');
  });
});

describe('compliance-report verify — abuse / fail-closed (untrusted input)', () => {
  it('rejects a TAMPERED payload (signature no longer matches)', async () => {
    const signer = await createEphemeralComplianceReportSigner();
    const jws = await signer.signReport(sampleReport());
    const [h, , s] = jws.split('.');
    // Flip the payload to a different report body but keep the original signature.
    const forgedPayload = Buffer.from(
      JSON.stringify({ report: complianceReportClaims(violatingReport()) }),
    ).toString('base64url');
    const tampered = `${h}.${forgedPayload}.${s}`;
    await expect(verifyComplianceReport(tampered, await signer.publicKeyJwk())).rejects.toThrow(
      /signature verification failed/,
    );
  });

  it('rejects verification with the WRONG public key (different keypair)', async () => {
    const signer = await createEphemeralComplianceReportSigner();
    const other = await createEphemeralComplianceReportSigner();
    const jws = await signer.signReport(sampleReport());
    await expect(verifyComplianceReport(jws, await other.publicKeyJwk())).rejects.toThrow(
      /signature verification failed/,
    );
  });

  it('rejects alg-confusion: a token with alg=none', async () => {
    const signer = await createEphemeralComplianceReportSigner();
    const pub = await signer.publicKeyJwk();
    const header = Buffer.from(
      JSON.stringify({ alg: 'none', typ: COMPLIANCE_REPORT_TYP }),
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ report: complianceReportClaims(sampleReport()) }),
    ).toString('base64url');
    const noneToken = `${header}.${payload}.`;
    await expect(verifyComplianceReport(noneToken, pub)).rejects.toThrow();
  });

  it('rejects alg-confusion: an HS256 (symmetric) token signed with the public key bytes', async () => {
    const signer = await createEphemeralComplianceReportSigner();
    const pub = await signer.publicKeyJwk();
    const fakeSecret = new TextEncoder().encode(JSON.stringify(pub));
    const hsToken = await new SignJWT({ report: complianceReportClaims(sampleReport()) })
      .setProtectedHeader({ alg: 'HS256', typ: COMPLIANCE_REPORT_TYP })
      .sign(fakeSecret);
    await expect(verifyComplianceReport(hsToken, pub)).rejects.toThrow();
  });

  it('rejects a token signed with EdDSA but a non-report typ header (confused deputy)', async () => {
    const { privateKey, publicKey } = await generateKeyPair(COMPLIANCE_REPORT_ALG, {
      extractable: true,
    });
    const pub = await exportJWK(publicKey);
    const jws = await new SignJWT({ report: complianceReportClaims(sampleReport()) })
      .setProtectedHeader({ alg: COMPLIANCE_REPORT_ALG, typ: 'application/some-other+jws' })
      .sign(privateKey);
    await expect(verifyComplianceReport(jws, pub)).rejects.toThrow(
      /unexpected or missing compliance-report type/,
    );
  });

  it('CROSS-TYPE: an erasure-certificate JWS does NOT verify as a compliance report', async () => {
    // Same key, wrong artifact class: an erasure cert's typ is `application/erasure-cert+jws`, so it
    // must be rejected by the compliance verifier even when the signature is valid (the whole point
    // of the distinct typ — ADR-0011 / std-cwe cross-type confusion).
    const { privateKey, publicKey } = await generateKeyPair(COMPLIANCE_REPORT_ALG, {
      extractable: true,
    });
    const pub = await exportJWK(publicKey);
    const cert = buildErasureCertificate({
      tenant: tenant(),
      reason: 'GDPR Art.17',
      erasedAt: '2026-06-20T00:00:00.000Z',
      exported: false,
      projectDeleted: true,
      secretShredded: true,
      statusDeleted: true,
    });
    const erasureJws = await new SignJWT({ cert: erasureCertClaims(cert) })
      .setProtectedHeader({ alg: COMPLIANCE_REPORT_ALG, typ: ERASURE_CERT_TYP })
      .sign(privateKey);
    await expect(verifyComplianceReport(erasureJws, pub)).rejects.toThrow(
      /unexpected or missing compliance-report type/,
    );
  });

  it('CROSS-TYPE: a real erasure signer + verifier pair is rejected by the compliance verifier', async () => {
    // End-to-end: a genuinely signed erasure certificate (its own signer) presented to the compliance
    // verifier with that signer's public key is rejected (the certificate signer pins the erasure typ).
    const erasureSigner = await createEphemeralCertificateSigner();
    const cert = buildErasureCertificate({
      tenant: tenant(),
      reason: 'GDPR Art.17',
      erasedAt: '2026-06-20T00:00:00.000Z',
      exported: false,
      projectDeleted: true,
      secretShredded: true,
      statusDeleted: true,
    });
    const erasureJws = await erasureSigner.sign(cert);
    await expect(
      verifyComplianceReport(erasureJws, await erasureSigner.publicKeyJwk()),
    ).rejects.toThrow(/unexpected or missing compliance-report type/);
  });

  it('rejects a structurally-valid signature over a malformed report body (missing fields)', async () => {
    const { privateKey, publicKey } = await generateKeyPair(COMPLIANCE_REPORT_ALG, {
      extractable: true,
    });
    const pub = await exportJWK(publicKey);
    const jws = await new SignJWT({ report: { generatedAt: '2026-06-25T00:00:00.000Z' } })
      .setProtectedHeader({ alg: COMPLIANCE_REPORT_ALG, typ: COMPLIANCE_REPORT_TYP })
      .sign(privateKey);
    await expect(verifyComplianceReport(jws, pub)).rejects.toThrow(/malformed inventory block/);
  });

  it('rejects an inventory byStatus with unexpected/missing status keys (allow-list)', async () => {
    const { privateKey, publicKey } = await generateKeyPair(COMPLIANCE_REPORT_ALG, {
      extractable: true,
    });
    const pub = await exportJWK(publicKey);
    const claims = complianceReportClaims(sampleReport());
    (claims.inventory as { byStatus: Record<string, number> }).byStatus = { active: 1 }; // missing keys
    const jws = await new SignJWT({ report: claims })
      .setProtectedHeader({ alg: COMPLIANCE_REPORT_ALG, typ: COMPLIANCE_REPORT_TYP })
      .sign(privateKey);
    await expect(verifyComplianceReport(jws, pub)).rejects.toThrow(/unexpected keys/);
  });

  it('rejects a report missing the report claim entirely', async () => {
    const { privateKey, publicKey } = await generateKeyPair(COMPLIANCE_REPORT_ALG, {
      extractable: true,
    });
    const pub = await exportJWK(publicKey);
    const jws = await new SignJWT({ notreport: true })
      .setProtectedHeader({ alg: COMPLIANCE_REPORT_ALG, typ: COMPLIANCE_REPORT_TYP })
      .sign(privateKey);
    await expect(verifyComplianceReport(jws, pub)).rejects.toThrow(/missing the report claim/);
  });

  it('rejects an empty / non-string JWS', async () => {
    const signer = await createEphemeralComplianceReportSigner();
    await expect(verifyComplianceReport('', await signer.publicKeyJwk())).rejects.toThrow(
      /empty or non-string/,
    );
  });

  it('rejects a non-Ed25519 public key (wrong kty/crv)', async () => {
    const signer = await createEphemeralComplianceReportSigner();
    const jws = await signer.signReport(sampleReport());
    await expect(
      verifyComplianceReport(jws, { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' }),
    ).rejects.toThrow(/must be an Ed25519/);
  });

  it('refuses a PRIVATE key where a public one is expected', async () => {
    const { privateKey } = await generateKeyPair(COMPLIANCE_REPORT_ALG, { extractable: true });
    const privJwk = await exportJWK(privateKey);
    expect(privJwk.d).toBeDefined();
    const signer = await createEd25519ComplianceReportSigner({ privateKey: privJwk });
    const jws = await signer.signReport(sampleReport());
    await expect(verifyComplianceReport(jws, privJwk)).rejects.toThrow(/private material present/);
  });

  it('rejects a non-JWS string (garbage input)', async () => {
    const signer = await createEphemeralComplianceReportSigner();
    await expect(
      verifyComplianceReport('not-a-jws', await signer.publicKeyJwk()),
    ).rejects.toThrow();
  });

  it('rejects a validly-signed payload that is not valid JSON', async () => {
    const { privateKey, publicKey } = await generateKeyPair(COMPLIANCE_REPORT_ALG, {
      extractable: true,
    });
    const pub = await exportJWK(publicKey);
    const jws = await new CompactSign(new TextEncoder().encode('not json at all'))
      .setProtectedHeader({ alg: COMPLIANCE_REPORT_ALG, typ: COMPLIANCE_REPORT_TYP })
      .sign(privateKey);
    await expect(verifyComplianceReport(jws, pub)).rejects.toThrow(/not valid JSON/);
  });

  it('rejects a validly-signed payload whose JSON is not an object (e.g. a number)', async () => {
    const { privateKey, publicKey } = await generateKeyPair(COMPLIANCE_REPORT_ALG, {
      extractable: true,
    });
    const pub = await exportJWK(publicKey);
    const jws = await new CompactSign(new TextEncoder().encode('42'))
      .setProtectedHeader({ alg: COMPLIANCE_REPORT_ALG, typ: COMPLIANCE_REPORT_TYP })
      .sign(privateKey);
    await expect(verifyComplianceReport(jws, pub)).rejects.toThrow(/payload is not an object/);
  });

  it('rejects a report whose residency block is malformed', async () => {
    const { privateKey, publicKey } = await generateKeyPair(COMPLIANCE_REPORT_ALG, {
      extractable: true,
    });
    const pub = await exportJWK(publicKey);
    const claims = complianceReportClaims(sampleReport());
    claims.residency = {
      compliant: true,
      allowedRegions: 'not-an-array',
      byJurisdiction: {},
      violations: [],
    };
    const jws = await new SignJWT({ report: claims })
      .setProtectedHeader({ alg: COMPLIANCE_REPORT_ALG, typ: COMPLIANCE_REPORT_TYP })
      .sign(privateKey);
    await expect(verifyComplianceReport(jws, pub)).rejects.toThrow(/malformed residency block/);
  });

  it('rejects a report whose audit entry has a bad outcome', async () => {
    const { privateKey, publicKey } = await generateKeyPair(COMPLIANCE_REPORT_ALG, {
      extractable: true,
    });
    const pub = await exportJWK(publicKey);
    const claims = complianceReportClaims(sampleReport());
    (claims.audit as { recent: unknown[] }).recent = [
      { at: '2026-06-24T00:00:00.000Z', event: 'x', outcome: 'maybe' },
    ];
    const jws = await new SignJWT({ report: claims })
      .setProtectedHeader({ alg: COMPLIANCE_REPORT_ALG, typ: COMPLIANCE_REPORT_TYP })
      .sign(privateKey);
    await expect(verifyComplianceReport(jws, pub)).rejects.toThrow(/malformed audit entry/);
  });
});

describe('compliance-report verify — every shape guard fails closed (allow-list reconstruction)', () => {
  // Sign an arbitrary (deliberately malformed) claims body with a valid EdDSA key + the correct typ,
  // so the signature and type gates PASS and the reconstruction shape guards are what reject it. This
  // exercises each `throw` branch in reconstruct{Inventory,Isolation,Residency,Audit,AuditEntry}.
  async function signMalformed(
    mutate: (claims: Record<string, unknown>) => void,
  ): Promise<{ jws: string; pub: JWK }> {
    const { privateKey, publicKey } = await generateKeyPair(COMPLIANCE_REPORT_ALG, {
      extractable: true,
    });
    const pub = await exportJWK(publicKey);
    const claims = complianceReportClaims(sampleReport());
    mutate(claims);
    const jws = await new SignJWT({ report: claims })
      .setProtectedHeader({ alg: COMPLIANCE_REPORT_ALG, typ: COMPLIANCE_REPORT_TYP })
      .sign(privateKey);
    return { jws, pub };
  }

  it('rejects a non-object inventory total / byStatus', async () => {
    const { jws, pub } = await signMalformed((c) => {
      c.inventory = { total: -1, byStatus: {} };
    });
    await expect(verifyComplianceReport(jws, pub)).rejects.toThrow(/malformed inventory block/);
  });

  it('rejects an inventory byStatus with a non-integer count (all keys present)', async () => {
    const { jws, pub } = await signMalformed((c) => {
      (c.inventory as { byStatus: Record<string, unknown> }).byStatus = {
        provisioning: 0,
        active: 1.5,
        suspended: 0,
        offboarding: 0,
        deleted: 0,
      };
    });
    await expect(verifyComplianceReport(jws, pub)).rejects.toThrow(/byStatus has an invalid count/);
  });

  it('rejects a report with a non-string generatedAt', async () => {
    const { jws, pub } = await signMalformed((c) => {
      c.generatedAt = 42;
    });
    await expect(verifyComplianceReport(jws, pub)).rejects.toThrow(/report has an invalid shape/);
  });

  it('rejects a non-object isolation block', async () => {
    const { jws, pub } = await signMalformed((c) => {
      c.isolation = 42;
    });
    await expect(verifyComplianceReport(jws, pub)).rejects.toThrow(/malformed isolation block/);
  });

  it('rejects a non-object residency block', async () => {
    const { jws, pub } = await signMalformed((c) => {
      c.residency = 42;
    });
    await expect(verifyComplianceReport(jws, pub)).rejects.toThrow(/malformed residency block/);
  });

  it('rejects an isolation block with a non-boolean compliant flag', async () => {
    const { jws, pub } = await signMalformed((c) => {
      c.isolation = { compliant: 'yes', missingProject: [], sharedProjects: [] };
    });
    await expect(verifyComplianceReport(jws, pub)).rejects.toThrow(/malformed isolation block/);
  });

  it('rejects a non-object sharedProjects entry', async () => {
    const { jws, pub } = await signMalformed((c) => {
      (c.isolation as { sharedProjects: unknown[] }).sharedProjects = [42];
    });
    await expect(verifyComplianceReport(jws, pub)).rejects.toThrow(
      /malformed sharedProjects entry/,
    );
  });

  it('rejects a sharedProjects entry with mistyped fields', async () => {
    const { jws, pub } = await signMalformed((c) => {
      (c.isolation as { sharedProjects: unknown[] }).sharedProjects = [
        { neonProjectId: 1, tenantIds: ['t1'] },
      ];
    });
    await expect(verifyComplianceReport(jws, pub)).rejects.toThrow(
      /malformed sharedProjects entry/,
    );
  });

  it('rejects a residency byJurisdiction with an invalid count', async () => {
    const { jws, pub } = await signMalformed((c) => {
      (c.residency as { byJurisdiction: Record<string, unknown> }).byJurisdiction = { EU: -3 };
    });
    await expect(verifyComplianceReport(jws, pub)).rejects.toThrow(
      /byJurisdiction has an invalid count/,
    );
  });

  it('rejects a non-object residency violation', async () => {
    const { jws, pub } = await signMalformed((c) => {
      (c.residency as { violations: unknown[] }).violations = [42];
    });
    await expect(verifyComplianceReport(jws, pub)).rejects.toThrow(/malformed residency violation/);
  });

  it('rejects a residency violation with missing/mistyped fields', async () => {
    const { jws, pub } = await signMalformed((c) => {
      (c.residency as { violations: unknown[] }).violations = [
        { tenantId: 't1', region: 'r' }, // missing `reason`
      ];
    });
    await expect(verifyComplianceReport(jws, pub)).rejects.toThrow(/malformed residency violation/);
  });

  it('rejects a non-object audit block', async () => {
    const { jws, pub } = await signMalformed((c) => {
      c.audit = 42;
    });
    await expect(verifyComplianceReport(jws, pub)).rejects.toThrow(/malformed audit block/);
  });

  it('rejects an audit block whose erasures/recent are not arrays', async () => {
    const { jws, pub } = await signMalformed((c) => {
      c.audit = { erasures: 'nope', recent: [] };
    });
    await expect(verifyComplianceReport(jws, pub)).rejects.toThrow(/malformed audit block/);
  });

  it('rejects a non-object audit entry', async () => {
    const { jws, pub } = await signMalformed((c) => {
      (c.audit as { erasures: unknown[] }).erasures = [42];
    });
    await expect(verifyComplianceReport(jws, pub)).rejects.toThrow(/malformed audit entry/);
  });

  it('rejects an audit entry missing required at/event', async () => {
    const { jws, pub } = await signMalformed((c) => {
      (c.audit as { erasures: unknown[] }).erasures = [{ event: 'x', outcome: 'ok' }]; // no `at`
    });
    await expect(verifyComplianceReport(jws, pub)).rejects.toThrow(/malformed audit entry/);
  });

  it('rejects an audit entry whose actor is not an object', async () => {
    const { jws, pub } = await signMalformed((c) => {
      (c.audit as { erasures: unknown[] }).erasures = [
        { at: '2026-06-20T00:00:00.000Z', event: 'x', outcome: 'ok', actor: 42 },
      ];
    });
    await expect(verifyComplianceReport(jws, pub)).rejects.toThrow(/malformed audit entry actor/);
  });

  it('rejects an audit entry whose actor has mistyped id/role', async () => {
    const { jws, pub } = await signMalformed((c) => {
      (c.audit as { erasures: unknown[] }).erasures = [
        { at: '2026-06-20T00:00:00.000Z', event: 'x', outcome: 'ok', actor: { id: 1, role: 'r' } },
      ];
    });
    await expect(verifyComplianceReport(jws, pub)).rejects.toThrow(/malformed audit entry actor/);
  });

  it('rejects an audit entry whose tenantId is present but not a string', async () => {
    const { jws, pub } = await signMalformed((c) => {
      (c.audit as { erasures: unknown[] }).erasures = [
        { at: '2026-06-20T00:00:00.000Z', event: 'x', outcome: 'ok', tenantId: 42 },
      ];
    });
    await expect(verifyComplianceReport(jws, pub)).rejects.toThrow(
      /malformed audit entry tenantId/,
    );
  });
});

describe('complianceReportClaims canonicalization', () => {
  it('embeds exactly the report fields under `report` (no secrets / connection URIs)', () => {
    const claims = complianceReportClaims(sampleReport());
    expect(Object.keys(claims).sort()).toEqual(
      ['audit', 'generatedAt', 'inventory', 'isolation', 'residency'].sort(),
    );
    // No secret-bearing fields ever appear (the report is attestation facts only — master §5).
    const serialized = JSON.stringify(claims);
    expect(serialized).not.toMatch(/connection|postgres:\/\/|password|secret/i);
  });

  it('omits the audit section when the report has none', () => {
    const claims = complianceReportClaims(violatingReport());
    expect('audit' in claims).toBe(false);
  });

  it('produces bytes identical to JSON.stringify(report) (the digest covers the same canonical JSON)', () => {
    // The signed bytes (claims under `report`) must equal the report's own canonical JSON so the JWS
    // and the legacy SHA-256 digest anchor the SAME content (ADR-0011 Phase 1).
    const report = sampleReport();
    const claims = complianceReportClaims(report);
    expect(JSON.stringify(claims)).toBe(JSON.stringify(report));
  });

  it('exposes the pinned algorithm + typ constants', () => {
    expect(COMPLIANCE_REPORT_ALG).toBe('EdDSA');
    expect(COMPLIANCE_REPORT_TYP).toBe('application/compliance-report+jws');
  });
});
