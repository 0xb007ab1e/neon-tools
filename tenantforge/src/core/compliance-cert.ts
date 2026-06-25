import { compactVerify, importJWK, type JWK } from 'jose';
import type {
  ComplianceReport,
  ComplianceAuditEntry,
  ComplianceReportOptions,
} from './compliance.js';
import type { TenantStatus } from './domain.js';

/**
 * The single approved signature algorithm for signed compliance reports: **EdDSA (Ed25519)**
 * (`@rules/topic-cryptography.md`). Pinned on **both** sign and verify so a forged token can't
 * downgrade to `none`/`HS*` (alg-confusion — std-cwe; mirrors {@link import('./erasure-cert.js').ERASURE_CERT_ALG}).
 */
export const COMPLIANCE_REPORT_ALG = 'EdDSA';

/**
 * The JWS protected-header **type** for a signed compliance report — a domain tag, **distinct** from
 * the erasure certificate's `typ`, so a verifier (or a confused-deputy) can't accept a token minted
 * for another purpose under the same key (cross-type confusion — std-cwe). Phase 1 of the compliance
 * evidence layer (ADR-0011) deliberately separates the two artifact classes by `typ`.
 */
export const COMPLIANCE_REPORT_TYP = 'application/compliance-report+jws';

/** The custom claim under which the report body travels in the JWS payload. */
const REPORT_CLAIM = 'report';

/**
 * Map a {@link ComplianceReport} to a stable, canonical claim object for signing.
 *
 * The shape mirrors the report **exactly**, in the same field order the pure
 * {@link import('./compliance.js').buildComplianceReport} emits — so the signed bytes are
 * deterministic for a given report and equal the bytes the existing SHA-256 digest already covers
 * (the signature is the new integrity anchor over the same canonical JSON). The optional `audit`
 * section is included only when present, exactly as the report models it. Pure — no I/O, no clock.
 *
 * The report carries **attestation facts only** — counts, isolation/residency booleans + offending
 * ids, and an already-redacted audit excerpt. It holds **no secrets and no connection URIs**
 * (master §5); see the threat model's "signed compliance report" section.
 *
 * @param report - The report to canonicalize.
 * @returns The canonical claim object embedded in the JWS payload.
 */
export function complianceReportClaims(report: ComplianceReport): Record<string, unknown> {
  return {
    generatedAt: report.generatedAt,
    inventory: { total: report.inventory.total, byStatus: { ...report.inventory.byStatus } },
    isolation: {
      compliant: report.isolation.compliant,
      missingProject: [...report.isolation.missingProject],
      sharedProjects: report.isolation.sharedProjects.map((s) => ({
        neonProjectId: s.neonProjectId,
        tenantIds: [...s.tenantIds],
      })),
    },
    residency: {
      compliant: report.residency.compliant,
      allowedRegions: [...report.residency.allowedRegions],
      byJurisdiction: { ...report.residency.byJurisdiction },
      violations: report.residency.violations.map((v) => ({
        tenantId: v.tenantId,
        region: v.region,
        reason: v.reason,
      })),
    },
    ...(report.audit !== undefined
      ? {
          audit: {
            erasures: report.audit.erasures.map(toAuditClaim),
            recent: report.audit.recent.map(toAuditClaim),
          },
        }
      : {}),
  };
}

/** Project one audit entry to its canonical claim shape (optional fields included only when present). */
function toAuditClaim(e: ComplianceAuditEntry): Record<string, unknown> {
  return {
    at: e.at,
    event: e.event,
    outcome: e.outcome,
    ...(e.actor !== undefined ? { actor: { id: e.actor.id, role: e.actor.role } } : {}),
    ...(e.tenantId !== undefined ? { tenantId: e.tenantId } : {}),
  };
}

/**
 * A signed compliance report: the plain report plus its compact JWS authenticity anchor (and the
 * legacy SHA-256 integrity digest, kept for backward compatibility with callers that consume it).
 */
export interface SignedComplianceReport {
  /** The point-in-time attestation (no secrets — counts, booleans, ids, redacted audit excerpt). */
  report: ComplianceReport;
  /**
   * The compact JWS (`header.payload.signature`) signed with EdDSA over {@link complianceReportClaims}.
   * The **authenticity** anchor — an auditor verifies it offline with only the published public key
   * via {@link verifyComplianceReport}. Always present when a signer is configured.
   */
  jws: string;
  /**
   * SHA-256 hex digest of the canonical report JSON. A bare integrity anchor (proves the bytes are
   * unchanged, not who produced them); retained so existing digest consumers don't regress. The JWS
   * is the new authenticity anchor and the one auditors should rely on.
   */
  digest: string;
}

/** A boolean validator narrowing an `unknown` to `boolean`. */
function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

/** A string validator narrowing an `unknown` to `string`. */
function isString(v: unknown): v is string {
  return typeof v === 'string';
}

/** A non-negative-integer validator (tenant counts are non-negative integers). */
function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** A string-array validator. */
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}

/** The lifecycle statuses a report's `byStatus` map must enumerate (allow-list — no extra keys). */
const STATUS_KEYS: readonly TenantStatus[] = [
  'provisioning',
  'active',
  'suspended',
  'offboarding',
  'deleted',
];

/**
 * **Verify** a signed compliance report against a published Ed25519 public JWK and return the
 * report — the auditor path (std-owasp #8 integrity/authenticity verification). The verification is
 * **the product**: an auditor must be able to verify offline with only the public key.
 *
 * Fail-closed at every step (the JWS is **untrusted input** — std-cwe): the algorithm is pinned to
 * EdDSA (rejects `none`/`HS*`/any non-EdDSA — no alg-confusion), the header `typ` must be the
 * compliance-report type (so an **erasure-cert JWS does not verify here** — cross-type confusion),
 * the key must be an Ed25519 public key, and the payload must structurally match a report. Any
 * failure throws; the function never returns an unverified report.
 *
 * Pure given its inputs (no network, no clock, no shared state) — a strong unit/mutation target.
 * Mirrors {@link import('./erasure-cert.js').verifyErasureCertificate} exactly.
 *
 * @param jws - The compact JWS produced by {@link import('./compliance-cert.js').complianceReportClaims} via the certificate signer.
 * @param publicKeyJwk - The operator's published Ed25519 **public** JWK.
 * @returns The verified compliance report.
 * @throws Error if the signature, algorithm, header type, key, or payload shape is invalid.
 */
export async function verifyComplianceReport(
  jws: string,
  publicKeyJwk: JWK,
): Promise<ComplianceReport> {
  if (typeof jws !== 'string' || jws === '') {
    throw new Error('verifyComplianceReport: empty or non-string JWS');
  }
  // Refuse anything that isn't an EdDSA/Ed25519 public key up front — never let the token's header
  // pick the key type (alg-confusion defense begins at the key — std-cwe / topic-cryptography).
  if (publicKeyJwk.kty !== 'OKP' || publicKeyJwk.crv !== 'Ed25519') {
    throw new Error('verifyComplianceReport: public key must be an Ed25519 (OKP) JWK');
  }
  if (publicKeyJwk.d !== undefined) {
    // A private key was passed where a public one is expected — refuse rather than risk misuse.
    throw new Error('verifyComplianceReport: expected a public key (private material present)');
  }

  const key = await importJWK(publicKeyJwk, COMPLIANCE_REPORT_ALG);
  // `compactVerify` validates the EdDSA signature AND pins the accepted algorithm via `algorithms`,
  // so a token claiming `none`/`HS256`/any non-EdDSA alg is rejected here (no alg-confusion) — the
  // alg never needs a separate re-check (it can't reach past this gate as anything but EdDSA).
  let payloadBytes: Uint8Array;
  let protectedHeader: { alg?: string; typ?: string };
  try {
    const result = await compactVerify(jws, key, { algorithms: [COMPLIANCE_REPORT_ALG] });
    payloadBytes = result.payload;
    protectedHeader = result.protectedHeader;
  } catch (error) {
    // jose throws Error subclasses; `String(error)` renders them uniformly (no untestable branch).
    throw new Error(`verifyComplianceReport: signature verification failed: ${String(error)}`);
  }

  // Domain guard: reject a token minted for another purpose under the same key (confused deputy) —
  // e.g. an erasure certificate JWS, whose typ is `application/erasure-cert+jws`, fails here.
  if (protectedHeader.typ !== COMPLIANCE_REPORT_TYP) {
    throw new Error('verifyComplianceReport: unexpected or missing compliance-report type header');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    throw new Error('verifyComplianceReport: payload is not valid JSON');
  }
  return reconstructReport(parsed);
}

/**
 * Re-hydrate (and structurally validate) a {@link ComplianceReport} from a verified JWS payload.
 * Allow-list each field with a strict type check (std-owasp-proactive #5) — a payload missing or
 * mistyping any field is rejected (fail closed); we never coerce.
 *
 * @param parsed - The JSON-parsed JWS payload.
 * @returns The reconstructed report.
 * @throws Error if the payload does not match the report shape.
 */
function reconstructReport(parsed: unknown): ComplianceReport {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('verifyComplianceReport: payload is not an object');
  }
  const body = (parsed as Record<string, unknown>)[REPORT_CLAIM];
  if (typeof body !== 'object' || body === null) {
    throw new Error('verifyComplianceReport: payload is missing the report claim');
  }
  const r = body as Record<string, unknown>;

  if (!isString(r.generatedAt)) {
    throw new Error('verifyComplianceReport: report has an invalid shape');
  }
  const inventory = reconstructInventory(r.inventory);
  const isolation = reconstructIsolation(r.isolation);
  const residency = reconstructResidency(r.residency);
  const audit = r.audit === undefined ? undefined : reconstructAudit(r.audit);

  return {
    generatedAt: r.generatedAt,
    inventory,
    isolation,
    residency,
    ...(audit !== undefined ? { audit } : {}),
  };
}

/** Validate + rebuild the inventory block (total + an exact, complete per-status count map). */
function reconstructInventory(value: unknown): ComplianceReport['inventory'] {
  if (typeof value !== 'object' || value === null) {
    throw new Error('verifyComplianceReport: malformed inventory block');
  }
  const inv = value as Record<string, unknown>;
  const byStatusRaw = inv.byStatus;
  if (!isCount(inv.total) || typeof byStatusRaw !== 'object' || byStatusRaw === null) {
    throw new Error('verifyComplianceReport: malformed inventory block');
  }
  const src = byStatusRaw as Record<string, unknown>;
  // Allow-list exactly the known statuses (no extra keys, no missing keys, all non-negative ints).
  if (Object.keys(src).length !== STATUS_KEYS.length) {
    throw new Error('verifyComplianceReport: inventory byStatus has unexpected keys');
  }
  const byStatus = {} as Record<TenantStatus, number>;
  for (const status of STATUS_KEYS) {
    const n = src[status];
    if (!isCount(n)) {
      throw new Error('verifyComplianceReport: inventory byStatus has an invalid count');
    }
    byStatus[status] = n;
  }
  return { total: inv.total, byStatus };
}

/** Validate + rebuild the isolation attestation block. */
function reconstructIsolation(value: unknown): ComplianceReport['isolation'] {
  if (typeof value !== 'object' || value === null) {
    throw new Error('verifyComplianceReport: malformed isolation block');
  }
  const iso = value as Record<string, unknown>;
  if (
    !isBoolean(iso.compliant) ||
    !isStringArray(iso.missingProject) ||
    !Array.isArray(iso.sharedProjects)
  ) {
    throw new Error('verifyComplianceReport: malformed isolation block');
  }
  const sharedProjects = iso.sharedProjects.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('verifyComplianceReport: malformed sharedProjects entry');
    }
    const s = entry as Record<string, unknown>;
    if (!isString(s.neonProjectId) || !isStringArray(s.tenantIds)) {
      throw new Error('verifyComplianceReport: malformed sharedProjects entry');
    }
    return { neonProjectId: s.neonProjectId, tenantIds: s.tenantIds };
  });
  return { compliant: iso.compliant, missingProject: iso.missingProject, sharedProjects };
}

/** Validate + rebuild the residency attestation block. */
function reconstructResidency(value: unknown): ComplianceReport['residency'] {
  if (typeof value !== 'object' || value === null) {
    throw new Error('verifyComplianceReport: malformed residency block');
  }
  const res = value as Record<string, unknown>;
  if (
    !isBoolean(res.compliant) ||
    !isStringArray(res.allowedRegions) ||
    typeof res.byJurisdiction !== 'object' ||
    res.byJurisdiction === null ||
    !Array.isArray(res.violations)
  ) {
    throw new Error('verifyComplianceReport: malformed residency block');
  }
  const byJurisdictionSrc = res.byJurisdiction as Record<string, unknown>;
  const byJurisdiction: Record<string, number> = {};
  for (const [k, n] of Object.entries(byJurisdictionSrc)) {
    if (!isCount(n)) {
      throw new Error('verifyComplianceReport: residency byJurisdiction has an invalid count');
    }
    byJurisdiction[k] = n;
  }
  const violations = res.violations.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('verifyComplianceReport: malformed residency violation');
    }
    const v = entry as Record<string, unknown>;
    if (!isString(v.tenantId) || !isString(v.region) || !isString(v.reason)) {
      throw new Error('verifyComplianceReport: malformed residency violation');
    }
    return { tenantId: v.tenantId, region: v.region, reason: v.reason };
  });
  return {
    compliant: res.compliant,
    allowedRegions: res.allowedRegions,
    byJurisdiction,
    violations,
  };
}

/** Validate + rebuild the optional audit block (two newest-first arrays of redacted entries). */
function reconstructAudit(value: unknown): NonNullable<ComplianceReport['audit']> {
  if (typeof value !== 'object' || value === null) {
    throw new Error('verifyComplianceReport: malformed audit block');
  }
  const a = value as Record<string, unknown>;
  if (!Array.isArray(a.erasures) || !Array.isArray(a.recent)) {
    throw new Error('verifyComplianceReport: malformed audit block');
  }
  return {
    erasures: a.erasures.map(reconstructAuditEntry),
    recent: a.recent.map(reconstructAuditEntry),
  };
}

/** Validate + rebuild one redacted audit entry (optional actor/tenantId included only when present). */
function reconstructAuditEntry(value: unknown): ComplianceAuditEntry {
  if (typeof value !== 'object' || value === null) {
    throw new Error('verifyComplianceReport: malformed audit entry');
  }
  const e = value as Record<string, unknown>;
  if (!isString(e.at) || !isString(e.event) || (e.outcome !== 'ok' && e.outcome !== 'error')) {
    throw new Error('verifyComplianceReport: malformed audit entry');
  }
  let actor: ComplianceAuditEntry['actor'];
  if (e.actor !== undefined) {
    if (typeof e.actor !== 'object' || e.actor === null) {
      throw new Error('verifyComplianceReport: malformed audit entry actor');
    }
    const ac = e.actor as Record<string, unknown>;
    if (!isString(ac.id) || !isString(ac.role)) {
      throw new Error('verifyComplianceReport: malformed audit entry actor');
    }
    actor = { id: ac.id, role: ac.role };
  }
  if (e.tenantId !== undefined && !isString(e.tenantId)) {
    throw new Error('verifyComplianceReport: malformed audit entry tenantId');
  }
  return {
    at: e.at,
    event: e.event,
    outcome: e.outcome,
    ...(actor !== undefined ? { actor } : {}),
    ...(e.tenantId !== undefined ? { tenantId: e.tenantId } : {}),
  };
}

// Re-export the option type so downstream signing helpers can stay in one import.
export type { ComplianceReportOptions };
