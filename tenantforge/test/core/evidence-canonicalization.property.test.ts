import fc from 'fast-check';
import { generateKeyPair, exportJWK, SignJWT, importJWK } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import {
  complianceReportClaims,
  verifyComplianceReport,
  COMPLIANCE_REPORT_ALG,
  COMPLIANCE_REPORT_TYP,
} from '../../src/core/compliance-cert.js';
import {
  evidenceBundleClaims,
  verifyEvidenceBundle,
  EVIDENCE_BUNDLE_ALG,
  EVIDENCE_BUNDLE_TYP,
} from '../../src/core/evidence-bundle.js';
import type { ComplianceReport, ComplianceAuditEntry } from '../../src/core/compliance.js';
import type { EvidenceBundle } from '../../src/core/evidence-bundle.js';
import type { TenantStatus } from '../../src/core/domain.js';

// The async sign→verify properties generate an ephemeral Ed25519 key and run dozens of
// sign+verify rounds per case — legitimately ~5 s, which tipped over vitest's 5 s default and
// flaked CI under load. Give the file real headroom (the fast sync canonicalization props are
// unaffected — a higher ceiling doesn't slow a test that finishes in ms).
vi.setConfig({ testTimeout: 20_000 });

/**
 * Property-based tests for the compliance/evidence JWS canonicalization + sign/verify path
 * (ADR-0011). The canonical claim mapping must be deterministic and its verify path must accept a
 * correctly-signed claim and reject a tampered/cross-type one — the signature is the auditor's
 * offline integrity+authenticity anchor (std-owasp #8), so a canonicalization or verify defect is a
 * compliance-evidence integrity failure.
 */

const STATUS_KEYS: readonly TenantStatus[] = [
  'provisioning',
  'active',
  'suspended',
  'offboarding',
  'deleted',
];

// A small alphanumeric id/string generator — keeps generated inputs realistic and JSON-safe while
// still exercising ordering/structure invariants.
const idStr = fc.string({ minLength: 0, maxLength: 12 });
const count = fc.nat({ max: 10_000 });

// An ISO-8601 UTC instant generator (the shapes store times as strings verbatim).
const isoInstant = fc
  .date({
    min: new Date('2000-01-01T00:00:00.000Z'),
    max: new Date('2100-01-01T00:00:00.000Z'),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString());

const byStatus = fc.tuple(count, count, count, count, count).map(([a, b, c, d, e]) => ({
  provisioning: a,
  active: b,
  suspended: c,
  offboarding: d,
  deleted: e,
})) as fc.Arbitrary<Record<TenantStatus, number>>;

const inventory = fc.record({ total: count, byStatus });

const sharedProject = fc.record({
  neonProjectId: idStr,
  tenantIds: fc.array(idStr, { maxLength: 4 }),
});

const isolation = fc.record({
  compliant: fc.boolean(),
  missingProject: fc.array(idStr, { maxLength: 4 }),
  sharedProjects: fc.array(sharedProject, { maxLength: 3 }),
});

const violation = fc.record({ tenantId: idStr, region: idStr, reason: idStr });

const residency = fc.record({
  compliant: fc.boolean(),
  allowedRegions: fc.array(idStr, { maxLength: 4 }),
  byJurisdiction: fc.dictionary(idStr, count, { maxKeys: 4 }),
  violations: fc.array(violation, { maxLength: 3 }),
});

// A redacted audit entry with the optional actor/tenantId sometimes present (exercises the
// "included only when present" branch of the canonical mapping). Optional keys are *omitted* when
// absent (not set to undefined) to satisfy `exactOptionalPropertyTypes`.
const auditEntry: fc.Arbitrary<ComplianceAuditEntry> = fc
  .tuple(
    isoInstant,
    idStr,
    fc.constantFrom('ok' as const, 'error' as const),
    fc.option(fc.record({ id: idStr, role: idStr }), { nil: undefined }),
    fc.option(idStr, { nil: undefined }),
  )
  .map(([at, event, outcome, actor, tenantId]) => ({
    at,
    event,
    outcome,
    ...(actor !== undefined ? { actor } : {}),
    ...(tenantId !== undefined ? { tenantId } : {}),
  }));

const auditBlock = fc.record({
  erasures: fc.array(auditEntry, { maxLength: 3 }),
  recent: fc.array(auditEntry, { maxLength: 3 }),
});

const report: fc.Arbitrary<ComplianceReport> = fc
  .tuple(isoInstant, inventory, isolation, residency, fc.option(auditBlock, { nil: undefined }))
  .map(([generatedAt, inv, iso, res, audit]) => ({
    generatedAt,
    inventory: inv,
    isolation: iso,
    residency: res,
    ...(audit !== undefined ? { audit } : {}),
  }));

// An evidence bundle generator. contentHashes are opaque hex-ish strings for canonicalization
// purposes; the sign/verify path only requires them to be strings.
const hex = fc.string({
  unit: fc.constantFrom(...'0123456789abcdef'.split('')),
  minLength: 8,
  maxLength: 64,
});
const bundle: fc.Arbitrary<EvidenceBundle> = fc
  .tuple(
    fc.constantFrom('fleet' as const, 'tenant' as const),
    idStr.filter((s) => s.length > 0),
    isoInstant,
    inventory,
    isolation,
    residency,
    fc.array(auditEntry, { maxLength: 3 }),
    fc.array(idStr, { maxLength: 3 }),
    fc.record({
      inventory: hex,
      isolation: hex,
      residency: hex,
      auditExcerpt: hex,
      erasureCertificates: hex,
    }),
  )
  .map(([scope, tenantId, generatedAt, inv, iso, res, audit, certs, contentHashes]) => ({
    scope,
    ...(scope === 'tenant' ? { tenantId } : {}),
    generatedAt,
    artifacts: {
      inventory: inv,
      isolation: iso,
      residency: res,
      auditExcerpt: audit,
      erasureCertificates: certs,
    },
    contentHashes,
  }));

describe('complianceReportClaims — canonicalization properties', () => {
  it('is deterministic: same report ⇒ byte-identical canonical JSON', () => {
    fc.assert(
      fc.property(report, (r) => {
        expect(JSON.stringify(complianceReportClaims(r))).toBe(
          JSON.stringify(complianceReportClaims(r)),
        );
      }),
      { numRuns: 200 },
    );
  });

  it('is stable regardless of source-object key insertion order (order-independent)', () => {
    fc.assert(
      fc.property(report, (r) => {
        // Rebuild the top-level report object with keys in a shuffled order — the canonical mapping
        // reads fields by name, so the canonical JSON must be identical.
        const shuffled: ComplianceReport = {
          isolation: r.isolation,
          residency: r.residency,
          generatedAt: r.generatedAt,
          inventory: r.inventory,
          ...(r.audit !== undefined ? { audit: r.audit } : {}),
        };
        expect(JSON.stringify(complianceReportClaims(shuffled))).toBe(
          JSON.stringify(complianceReportClaims(r)),
        );
      }),
      { numRuns: 200 },
    );
  });

  it('only enumerates the fixed status keys in byStatus (no leakage of extra keys)', () => {
    fc.assert(
      fc.property(report, (r) => {
        const claims = complianceReportClaims(r) as {
          inventory: { byStatus: Record<string, unknown> };
        };
        expect(Object.keys(claims.inventory.byStatus).sort()).toEqual([...STATUS_KEYS].sort());
      }),
      { numRuns: 100 },
    );
  });
});

describe('evidenceBundleClaims — canonicalization properties', () => {
  it('is deterministic: same bundle ⇒ byte-identical canonical JSON', () => {
    fc.assert(
      fc.property(bundle, (b) => {
        expect(JSON.stringify(evidenceBundleClaims(b))).toBe(
          JSON.stringify(evidenceBundleClaims(b)),
        );
      }),
      { numRuns: 200 },
    );
  });

  it('carries tenantId in the claim iff the bundle is tenant-scoped', () => {
    fc.assert(
      fc.property(bundle, (b) => {
        const claims = evidenceBundleClaims(b) as { scope: string; tenantId?: unknown };
        if (b.scope === 'tenant') expect(claims.tenantId).toBe(b.tenantId);
        else expect('tenantId' in claims).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});

describe('compliance report sign → verify — properties (ephemeral Ed25519)', () => {
  it('a correctly-signed report verifies and reconstructs its canonical fields', async () => {
    const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    await fc.assert(
      fc.asyncProperty(report, async (r) => {
        const jws = await new SignJWT({ report: complianceReportClaims(r) })
          .setProtectedHeader({ alg: COMPLIANCE_REPORT_ALG, typ: COMPLIANCE_REPORT_TYP })
          .sign(privateKey);
        const verified = await verifyComplianceReport(jws, publicJwk);
        // Round-trip preserves the canonical claim shape exactly (byte-identical re-canonicalization).
        expect(JSON.stringify(complianceReportClaims(verified))).toBe(
          JSON.stringify(complianceReportClaims(r)),
        );
      }),
      { numRuns: 60 },
    );
  });

  it('a payload-tampered token never verifies (auth failure)', async () => {
    const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    await fc.assert(
      fc.asyncProperty(report, async (r) => {
        const jws = await new SignJWT({ report: complianceReportClaims(r) })
          .setProtectedHeader({ alg: COMPLIANCE_REPORT_ALG, typ: COMPLIANCE_REPORT_TYP })
          .sign(privateKey);
        // Flip one character of the base64url payload segment ⇒ signature no longer matches.
        const [h, p, s] = jws.split('.') as [string, string, string];
        const flip = p[0] === 'A' ? 'B' : 'A';
        const tampered = [h, flip + p.slice(1), s].join('.');
        await expect(verifyComplianceReport(tampered, publicJwk)).rejects.toThrow();
      }),
      { numRuns: 60 },
    );
  });

  it('a report JWS never verifies as an evidence bundle (cross-type confusion rejected)', async () => {
    const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    await fc.assert(
      fc.asyncProperty(report, async (r) => {
        const jws = await new SignJWT({ report: complianceReportClaims(r) })
          .setProtectedHeader({ alg: COMPLIANCE_REPORT_ALG, typ: COMPLIANCE_REPORT_TYP })
          .sign(privateKey);
        // Same key, correct signature — but the typ is a compliance report, not an evidence bundle.
        await expect(verifyEvidenceBundle(jws, publicJwk)).rejects.toThrow();
      }),
      { numRuns: 40 },
    );
  });
});

describe('evidence bundle sign → verify — properties (ephemeral Ed25519)', () => {
  it('a correctly-signed bundle verifies and reconstructs its canonical fields', async () => {
    const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    await fc.assert(
      fc.asyncProperty(bundle, async (b) => {
        const jws = await new SignJWT({ bundle: evidenceBundleClaims(b) })
          .setProtectedHeader({ alg: EVIDENCE_BUNDLE_ALG, typ: EVIDENCE_BUNDLE_TYP })
          .sign(privateKey);
        const verified = await verifyEvidenceBundle(jws, publicJwk);
        expect(JSON.stringify(evidenceBundleClaims(verified))).toBe(
          JSON.stringify(evidenceBundleClaims(b)),
        );
      }),
      { numRuns: 60 },
    );
  });

  it('rejects a bundle JWS signed under a DIFFERENT key (wrong public key)', async () => {
    const signer = await generateKeyPair('EdDSA', { extractable: true });
    const attacker = await generateKeyPair('EdDSA', { extractable: true });
    const attackerPublicJwk = await exportJWK(attacker.publicKey);
    await fc.assert(
      fc.asyncProperty(bundle, async (b) => {
        const jws = await new SignJWT({ bundle: evidenceBundleClaims(b) })
          .setProtectedHeader({ alg: EVIDENCE_BUNDLE_ALG, typ: EVIDENCE_BUNDLE_TYP })
          .sign(signer.privateKey);
        // Verifying with the attacker's public key must fail (authenticity is the anchor).
        await expect(verifyEvidenceBundle(jws, attackerPublicJwk)).rejects.toThrow();
      }),
      { numRuns: 40 },
    );
  });

  it('rejects any non-EdDSA algorithm (alg-confusion / downgrade)', async () => {
    // An HS256 token minted with a symmetric key must never verify against an Ed25519 public JWK
    // (the verify path pins EdDSA + refuses a non-OKP key up front).
    const { publicKey } = await generateKeyPair('EdDSA', { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    await fc.assert(
      fc.asyncProperty(bundle, fc.string({ minLength: 32, maxLength: 64 }), async (b, secret) => {
        const hsKey = await importJWK(
          { kty: 'oct', k: Buffer.from(secret).toString('base64url') },
          'HS256',
        );
        const jws = await new SignJWT({ bundle: evidenceBundleClaims(b) })
          .setProtectedHeader({ alg: 'HS256', typ: EVIDENCE_BUNDLE_TYP })
          .sign(hsKey);
        await expect(verifyEvidenceBundle(jws, publicJwk)).rejects.toThrow();
      }),
      { numRuns: 40 },
    );
  });
});
