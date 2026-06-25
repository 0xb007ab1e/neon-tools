import { createHash } from 'node:crypto';
import { compactVerify, importJWK, type JWK } from 'jose';
import {
  auditEntries,
  buildIsolationAttestation,
  buildResidencyAttestation,
  inventoryByStatus,
  type ComplianceAuditEntry,
  type ComplianceInventory,
  type ComplianceIsolation,
  type ComplianceResidency,
} from './compliance.js';
import type { TenantRecord } from './domain.js';
import type { TenantEvent } from './observability.js';

/**
 * The single approved signature algorithm for signed evidence bundles: **EdDSA (Ed25519)**
 * (`@rules/topic-cryptography.md`). Pinned on **both** sign and verify so a forged token can't
 * downgrade to `none`/`HS*` (alg-confusion — std-cwe; mirrors
 * {@link import('./compliance-cert.js').COMPLIANCE_REPORT_ALG} and
 * {@link import('./erasure-cert.js').ERASURE_CERT_ALG}).
 */
export const EVIDENCE_BUNDLE_ALG = 'EdDSA';

/**
 * The JWS protected-header **type** for a signed evidence bundle — a domain tag, **distinct** from
 * the compliance report's and the erasure certificate's `typ`, so a verifier (or a confused deputy)
 * can't accept a token minted for another purpose under the same key (cross-type confusion —
 * std-cwe). ADR-0011 Phase 2 deliberately separates the three artifact classes by `typ`/`kid`.
 */
export const EVIDENCE_BUNDLE_TYP = 'application/evidence-bundle+jws';

/** The custom claim under which the bundle body travels in the JWS payload. */
const BUNDLE_CLAIM = 'bundle';

/** The scope of an evidence bundle: the whole **fleet**, or a single **tenant**. */
export type EvidenceScope = 'fleet' | 'tenant';

/**
 * The evidence artifacts a bundle assembles — the same attestation building blocks the fleet
 * compliance report emits, plus the embedded **signed** erasure certificates. For a per-tenant
 * bundle every block is scoped to that one tenant; for a fleet bundle they cover the live fleet.
 *
 * Carries **attestation facts only** (counts, booleans, ids, a PII-minimized audit excerpt) and the
 * already-signed erasure-certificate JWS strings — **no secrets and no connection URIs** (master §5).
 */
export interface EvidenceArtifacts {
  /** Per-tenant (or fleet) inventory counted by lifecycle status. */
  inventory: ComplianceInventory;
  /** Physical-isolation attestation (each live tenant has its own dedicated Neon project). */
  isolation: ComplianceIsolation;
  /** Data-residency attestation (region → jurisdiction, within the org allow-list). */
  residency: ComplianceResidency;
  /**
   * A bounded, **PII-minimized** audit excerpt (newest-first) — the same redacted projection the
   * compliance report uses (`at/event/outcome/actor/tenantId`). For a per-tenant bundle this is
   * already filtered to the scoped tenant. Empty when no audit store is wired.
   */
  auditExcerpt: ComplianceAuditEntry[];
  /**
   * The **already-signed** erasure-certificate JWS strings folded in as **opaque, independently
   * verifiable** nested artifacts — each remains verifiable on its own via `verifyErasureCertificate`
   * against the erasure public key. **They are NOT re-signed**; the bundle signature covers their
   * bytes (so a swapped/tampered nested cert is detectable), but each cert keeps its own EdDSA
   * signature and `typ`. For a per-tenant bundle, only that tenant's certificate JWS strings appear.
   */
  erasureCertificates: string[];
}

/**
 * A point-in-time **evidence bundle** (ADR-0011 Phase 2) — a single, auditor-consumable pack of the
 * existing attestations (isolation, residency, a scoped audit excerpt) plus the embedded **signed**
 * erasure certificate(s), for either the whole **fleet** or a single **tenant**. Pure facts; it is a
 * **confidential** artifact (tenant ids, residency, an audit excerpt — threat-model B10) but carries
 * no secrets/connection URIs.
 *
 * Per-tenant scope is a **BOLA-sensitive boundary**: every artifact is filtered to the one
 * server-derived tenant id (retrieval/access-control is Phase 3, but the *content* is scoped here so
 * a tenant bundle can never carry another tenant's facts).
 */
export interface EvidenceBundle {
  /** Whether this bundle covers the whole fleet or a single tenant. */
  scope: EvidenceScope;
  /** The scoped tenant id — present **iff** `scope === 'tenant'` (server-derived; never client-supplied). */
  tenantId?: string;
  /** When the bundle was generated (ISO-8601 UTC; injected for determinism). */
  generatedAt: string;
  /** The assembled evidence artifacts. */
  artifacts: EvidenceArtifacts;
  /**
   * SHA-256 (hex) content hashes over each artifact's canonical JSON, so a consumer can **spot-check
   * individual parts** without re-deriving the whole bundle — consistent with the compliance report's
   * digest approach. The bundle's EdDSA signature still authenticates the whole; these are a
   * convenience integrity anchor per block (the erasure certificates carry their own signatures).
   */
  contentHashes: EvidenceContentHashes;
}

/** Per-artifact SHA-256 (hex) content hashes embedded in an {@link EvidenceBundle}. */
export interface EvidenceContentHashes {
  /** SHA-256 of the canonical inventory JSON. */
  inventory: string;
  /** SHA-256 of the canonical isolation-attestation JSON. */
  isolation: string;
  /** SHA-256 of the canonical residency-attestation JSON. */
  residency: string;
  /** SHA-256 of the canonical audit-excerpt JSON. */
  auditExcerpt: string;
  /** SHA-256 of the canonical erasure-certificate-JWS-array JSON. */
  erasureCertificates: string;
}

/** A signed evidence bundle: the plain bundle plus its compact JWS authenticity anchor. */
export interface SignedEvidenceBundle {
  /** The point-in-time evidence pack (no secrets — attestation facts + signed-cert JWS strings). */
  bundle: EvidenceBundle;
  /**
   * The compact JWS (`header.payload.signature`) signed with EdDSA over {@link evidenceBundleClaims}.
   * The **authenticity** anchor — an auditor verifies it offline with only the published public key
   * via {@link verifyEvidenceBundle}. Always present when a signer is configured.
   */
  jws: string;
}

/** Options for {@link buildEvidenceBundle}. */
export interface BuildEvidenceBundleOptions {
  /** Bundle scope: the whole fleet, or one tenant. */
  scope: EvidenceScope;
  /**
   * The tenant id to scope to — **required** when `scope === 'tenant'` (server-derived; this is the
   * BOLA boundary), forbidden when `scope === 'fleet'`.
   */
  tenantId?: string;
  /** Org region allow-list for the residency attestation (empty = unrestricted). */
  allowedRegions?: readonly string[];
  /** The generation instant (injected for determinism — pure core, no clock). */
  now: Date;
  /**
   * A bounded, already-redacted audit excerpt from the persisted store (newest-first or any order —
   * it is re-sorted). For a per-tenant bundle, events are filtered to the scoped tenant here as well
   * (defense in depth — the caller should also scope its query). Omit when no audit store is wired.
   */
  auditExcerpt?: readonly TenantEvent[];
  /**
   * The **already-signed** erasure-certificate JWS strings to fold in (opaque, not re-signed). For a
   * per-tenant bundle the caller passes only that tenant's certificate JWS strings; this builder does
   * not parse them (they are verified independently via `verifyErasureCertificate`). Omit/empty for
   * none.
   */
  erasureCertificates?: readonly string[];
}

/** SHA-256 (hex) over the canonical JSON of a value — the per-artifact content hash. */
function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Build a point-in-time **evidence bundle** from the tenant registry + audit excerpt + already-signed
 * erasure certificates — **pure** and deterministic (master §2; ADR-0011 Phase 2). Assembles the
 * **same** isolation/residency/inventory attestations the fleet compliance report uses (shared
 * builders — no duplication) plus a PII-minimized audit excerpt and the embedded signed erasure-cert
 * JWS string(s), for either the whole **fleet** or a single **tenant**.
 *
 * **Per-tenant scoping (BOLA boundary).** With `scope: 'tenant'` the bundle filters **every** artifact
 * to the one server-derived `tenantId`: the inventory counts only that tenant, the attestations cover
 * only it, the audit excerpt is filtered to its events, and only its erasure-certificate JWS strings
 * are folded in — so a tenant's bundle can never carry another tenant's facts (retrieval/access
 * control is Phase 3; the *content* is scoped here regardless). With `scope: 'fleet'` the attestations
 * cover the live fleet (deleted tenants are inventoried but excluded from attestations, as they have
 * no project).
 *
 * The embedded erasure certificates are **opaque, independently verifiable** JWS strings — they are
 * **not re-signed** (the bundle signature covers their bytes for tamper-evidence; each keeps its own
 * EdDSA signature + `typ`, verifiable via `verifyErasureCertificate`).
 *
 * @param tenants - All tenant records from the registry (filtered internally for per-tenant scope).
 * @param options - Scope (+ tenant id), allow-list, the generation instant, audit excerpt, and the
 *   already-signed erasure-certificate JWS strings.
 * @returns The evidence bundle (arrays sorted, hashes computed — a stable, hashable output).
 * @throws Error if `scope: 'tenant'` without a `tenantId`, `scope: 'fleet'` with one, or the scoped
 *   tenant is not in the registry (fail closed — never emit an empty/ambiguous per-tenant bundle).
 */
export function buildEvidenceBundle(
  tenants: readonly TenantRecord[],
  options: BuildEvidenceBundleOptions,
): EvidenceBundle {
  const allowedRegions = options.allowedRegions ?? [];
  const erasureCertificates = [...(options.erasureCertificates ?? [])];
  const auditEvents = options.auditExcerpt ?? [];

  // Validate the scope/tenantId pairing up front — fail closed on an ambiguous request (master §2).
  if (options.scope === 'tenant') {
    if (options.tenantId === undefined || options.tenantId === '') {
      throw new Error('buildEvidenceBundle: scope "tenant" requires a non-empty tenantId');
    }
    if (!tenants.some((t) => t.id === options.tenantId)) {
      // Never emit a per-tenant bundle for an unknown tenant (an empty attestation would be a
      // misleading "all clear"; complete mediation — fail closed).
      throw new Error('buildEvidenceBundle: scoped tenant is not present in the registry');
    }
  } else if (options.tenantId !== undefined) {
    throw new Error('buildEvidenceBundle: scope "fleet" must not be given a tenantId');
  }

  // Scope the tenant set: per-tenant → exactly the one tenant; fleet → everyone.
  const scoped =
    options.scope === 'tenant' ? tenants.filter((t) => t.id === options.tenantId) : tenants;
  // Attestations cover the live (non-`deleted`) members of the scoped set (their project is gone).
  const live = scoped.filter((t) => t.status !== 'deleted');

  // Per-tenant: filter the audit excerpt to the scoped tenant (defense in depth — the caller's query
  // should already scope it, but never let another tenant's event leak into a tenant bundle).
  const scopedAudit =
    options.scope === 'tenant'
      ? auditEvents.filter((e) => e.tenantId === options.tenantId)
      : auditEvents;

  const artifacts: EvidenceArtifacts = {
    inventory: inventoryByStatus(scoped),
    isolation: buildIsolationAttestation(live),
    residency: buildResidencyAttestation(live, allowedRegions),
    auditExcerpt: auditEntries(scopedAudit),
    erasureCertificates,
  };

  const contentHashes: EvidenceContentHashes = {
    inventory: sha256Json(artifacts.inventory),
    isolation: sha256Json(artifacts.isolation),
    residency: sha256Json(artifacts.residency),
    auditExcerpt: sha256Json(artifacts.auditExcerpt),
    erasureCertificates: sha256Json(artifacts.erasureCertificates),
  };

  return {
    scope: options.scope,
    ...(options.scope === 'tenant' ? { tenantId: options.tenantId } : {}),
    generatedAt: options.now.toISOString(),
    artifacts,
    contentHashes,
  };
}

/**
 * Map an {@link EvidenceBundle} to a stable, canonical claim object for signing.
 *
 * The shape mirrors the bundle **exactly**, in the same field order {@link buildEvidenceBundle}
 * emits, so the signed bytes are deterministic for a given bundle. The embedded erasure-certificate
 * JWS strings are carried **verbatim** (opaque — never parsed or re-signed). Pure — no I/O, no clock.
 *
 * The bundle carries **attestation facts only** — counts, booleans, ids, a redacted audit excerpt,
 * and signed-cert JWS strings. It holds **no secrets and no connection URIs** (master §5).
 *
 * @param bundle - The bundle to canonicalize.
 * @returns The canonical claim object embedded in the JWS payload.
 */
export function evidenceBundleClaims(bundle: EvidenceBundle): Record<string, unknown> {
  return {
    scope: bundle.scope,
    ...(bundle.tenantId !== undefined ? { tenantId: bundle.tenantId } : {}),
    generatedAt: bundle.generatedAt,
    artifacts: {
      inventory: {
        total: bundle.artifacts.inventory.total,
        byStatus: { ...bundle.artifacts.inventory.byStatus },
      },
      isolation: {
        compliant: bundle.artifacts.isolation.compliant,
        missingProject: [...bundle.artifacts.isolation.missingProject],
        sharedProjects: bundle.artifacts.isolation.sharedProjects.map((s) => ({
          neonProjectId: s.neonProjectId,
          tenantIds: [...s.tenantIds],
        })),
      },
      residency: {
        compliant: bundle.artifacts.residency.compliant,
        allowedRegions: [...bundle.artifacts.residency.allowedRegions],
        byJurisdiction: { ...bundle.artifacts.residency.byJurisdiction },
        violations: bundle.artifacts.residency.violations.map((v) => ({
          tenantId: v.tenantId,
          region: v.region,
          reason: v.reason,
        })),
      },
      auditExcerpt: bundle.artifacts.auditExcerpt.map(toAuditClaim),
      erasureCertificates: [...bundle.artifacts.erasureCertificates],
    },
    contentHashes: {
      inventory: bundle.contentHashes.inventory,
      isolation: bundle.contentHashes.isolation,
      residency: bundle.contentHashes.residency,
      auditExcerpt: bundle.contentHashes.auditExcerpt,
      erasureCertificates: bundle.contentHashes.erasureCertificates,
    },
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

/** The lifecycle statuses a bundle's `byStatus` map must enumerate (allow-list — no extra keys). */
const STATUS_KEYS: readonly TenantRecord['status'][] = [
  'provisioning',
  'active',
  'suspended',
  'offboarding',
  'deleted',
];

/**
 * **Verify** a signed evidence bundle against a published Ed25519 public JWK and return the bundle —
 * the auditor path (std-owasp #8 integrity/authenticity verification). Verification is **the
 * product**: an auditor must be able to verify offline with only the public key.
 *
 * Fail-closed at every step (the JWS is **untrusted input** — std-cwe): the algorithm is pinned to
 * EdDSA (rejects `none`/`HS*`/any non-EdDSA — no alg-confusion), the header `typ` must be the
 * evidence-bundle type (so a **compliance-report or erasure-cert JWS does not verify here** —
 * cross-type confusion), the key must be an Ed25519 public key, and the payload must structurally
 * match a bundle. Any failure throws; the function never returns an unverified bundle.
 *
 * This verifies the **bundle envelope** only. The embedded erasure-certificate JWS strings are
 * returned verbatim and remain **independently verifiable** via `verifyErasureCertificate` against
 * the erasure public key — a consumer verifies each nested certificate separately (the bundle
 * signature also covers their bytes, so a swap/tamper of an embedded cert breaks bundle verification).
 *
 * Pure given its inputs (no network, no clock, no shared state) — a strong unit/mutation target.
 * Mirrors {@link import('./compliance-cert.js').verifyComplianceReport} exactly.
 *
 * @param jws - The compact JWS produced from {@link evidenceBundleClaims} via the evidence-bundle signer.
 * @param publicKeyJwk - The operator's published Ed25519 **public** JWK.
 * @returns The verified evidence bundle.
 * @throws Error if the signature, algorithm, header type, key, or payload shape is invalid.
 */
export async function verifyEvidenceBundle(
  jws: string,
  publicKeyJwk: JWK,
): Promise<EvidenceBundle> {
  if (typeof jws !== 'string' || jws === '') {
    throw new Error('verifyEvidenceBundle: empty or non-string JWS');
  }
  // Refuse anything that isn't an EdDSA/Ed25519 public key up front — never let the token's header
  // pick the key type (alg-confusion defense begins at the key — std-cwe / topic-cryptography).
  if (publicKeyJwk.kty !== 'OKP' || publicKeyJwk.crv !== 'Ed25519') {
    throw new Error('verifyEvidenceBundle: public key must be an Ed25519 (OKP) JWK');
  }
  if (publicKeyJwk.d !== undefined) {
    // A private key was passed where a public one is expected — refuse rather than risk misuse.
    throw new Error('verifyEvidenceBundle: expected a public key (private material present)');
  }

  const key = await importJWK(publicKeyJwk, EVIDENCE_BUNDLE_ALG);
  // `compactVerify` validates the EdDSA signature AND pins the accepted algorithm via `algorithms`,
  // so a token claiming `none`/`HS256`/any non-EdDSA alg is rejected here (no alg-confusion) — the
  // alg never needs a separate re-check (it can't reach past this gate as anything but EdDSA).
  let payloadBytes: Uint8Array;
  let protectedHeader: { alg?: string; typ?: string };
  try {
    const result = await compactVerify(jws, key, { algorithms: [EVIDENCE_BUNDLE_ALG] });
    payloadBytes = result.payload;
    protectedHeader = result.protectedHeader;
  } catch (error) {
    // jose throws Error subclasses; `String(error)` renders them uniformly (no untestable branch).
    throw new Error(`verifyEvidenceBundle: signature verification failed: ${String(error)}`);
  }

  // Domain guard: reject a token minted for another purpose under the same key (confused deputy) —
  // a compliance-report JWS (`application/compliance-report+jws`) or an erasure-cert JWS
  // (`application/erasure-cert+jws`) fails here.
  if (protectedHeader.typ !== EVIDENCE_BUNDLE_TYP) {
    throw new Error('verifyEvidenceBundle: unexpected or missing evidence-bundle type header');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    throw new Error('verifyEvidenceBundle: payload is not valid JSON');
  }
  return reconstructBundle(parsed);
}

/**
 * Re-hydrate (and structurally validate) an {@link EvidenceBundle} from a verified JWS payload.
 * Allow-list each field with a strict type check (std-owasp-proactive #5) — a payload missing or
 * mistyping any field is rejected (fail closed); we never coerce.
 *
 * @param parsed - The JSON-parsed JWS payload.
 * @returns The reconstructed bundle.
 * @throws Error if the payload does not match the bundle shape.
 */
function reconstructBundle(parsed: unknown): EvidenceBundle {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('verifyEvidenceBundle: payload is not an object');
  }
  const body = (parsed as Record<string, unknown>)[BUNDLE_CLAIM];
  if (typeof body !== 'object' || body === null) {
    throw new Error('verifyEvidenceBundle: payload is missing the bundle claim');
  }
  const b = body as Record<string, unknown>;

  if ((b.scope !== 'fleet' && b.scope !== 'tenant') || !isString(b.generatedAt)) {
    throw new Error('verifyEvidenceBundle: bundle has an invalid shape');
  }
  // The scope ↔ tenantId pairing is part of the contract: a tenant bundle must carry a tenant id;
  // a fleet bundle must not (a fleet bundle bearing a tenant id is malformed/forged — fail closed).
  if (b.scope === 'tenant') {
    if (!isString(b.tenantId)) {
      throw new Error('verifyEvidenceBundle: tenant-scoped bundle missing a string tenantId');
    }
  } else if (b.tenantId !== undefined) {
    throw new Error('verifyEvidenceBundle: fleet-scoped bundle must not carry a tenantId');
  }

  const artifacts = reconstructArtifacts(b.artifacts);
  const contentHashes = reconstructContentHashes(b.contentHashes);

  return {
    scope: b.scope,
    ...(b.scope === 'tenant' ? { tenantId: b.tenantId as string } : {}),
    generatedAt: b.generatedAt,
    artifacts,
    contentHashes,
  };
}

/** Validate + rebuild the artifacts block. */
function reconstructArtifacts(value: unknown): EvidenceArtifacts {
  if (typeof value !== 'object' || value === null) {
    throw new Error('verifyEvidenceBundle: malformed artifacts block');
  }
  const a = value as Record<string, unknown>;
  if (!isStringArray(a.erasureCertificates)) {
    throw new Error('verifyEvidenceBundle: malformed erasureCertificates (expected string[])');
  }
  return {
    inventory: reconstructInventory(a.inventory),
    isolation: reconstructIsolation(a.isolation),
    residency: reconstructResidency(a.residency),
    auditExcerpt: reconstructAuditExcerpt(a.auditExcerpt),
    erasureCertificates: a.erasureCertificates,
  };
}

/** Validate + rebuild the inventory block (total + an exact, complete per-status count map). */
function reconstructInventory(value: unknown): ComplianceInventory {
  if (typeof value !== 'object' || value === null) {
    throw new Error('verifyEvidenceBundle: malformed inventory block');
  }
  const inv = value as Record<string, unknown>;
  const byStatusRaw = inv.byStatus;
  if (!isCount(inv.total) || typeof byStatusRaw !== 'object' || byStatusRaw === null) {
    throw new Error('verifyEvidenceBundle: malformed inventory block');
  }
  const src = byStatusRaw as Record<string, unknown>;
  // Allow-list exactly the known statuses (no extra keys, no missing keys, all non-negative ints).
  if (Object.keys(src).length !== STATUS_KEYS.length) {
    throw new Error('verifyEvidenceBundle: inventory byStatus has unexpected keys');
  }
  const byStatus = {} as ComplianceInventory['byStatus'];
  for (const status of STATUS_KEYS) {
    const n = src[status];
    if (!isCount(n)) {
      throw new Error('verifyEvidenceBundle: inventory byStatus has an invalid count');
    }
    byStatus[status] = n;
  }
  return { total: inv.total, byStatus };
}

/** Validate + rebuild the isolation attestation block. */
function reconstructIsolation(value: unknown): ComplianceIsolation {
  if (typeof value !== 'object' || value === null) {
    throw new Error('verifyEvidenceBundle: malformed isolation block');
  }
  const iso = value as Record<string, unknown>;
  if (
    !isBoolean(iso.compliant) ||
    !isStringArray(iso.missingProject) ||
    !Array.isArray(iso.sharedProjects)
  ) {
    throw new Error('verifyEvidenceBundle: malformed isolation block');
  }
  const sharedProjects = iso.sharedProjects.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('verifyEvidenceBundle: malformed sharedProjects entry');
    }
    const s = entry as Record<string, unknown>;
    if (!isString(s.neonProjectId) || !isStringArray(s.tenantIds)) {
      throw new Error('verifyEvidenceBundle: malformed sharedProjects entry');
    }
    return { neonProjectId: s.neonProjectId, tenantIds: s.tenantIds };
  });
  return { compliant: iso.compliant, missingProject: iso.missingProject, sharedProjects };
}

/** Validate + rebuild the residency attestation block. */
function reconstructResidency(value: unknown): ComplianceResidency {
  if (typeof value !== 'object' || value === null) {
    throw new Error('verifyEvidenceBundle: malformed residency block');
  }
  const res = value as Record<string, unknown>;
  if (
    !isBoolean(res.compliant) ||
    !isStringArray(res.allowedRegions) ||
    typeof res.byJurisdiction !== 'object' ||
    res.byJurisdiction === null ||
    !Array.isArray(res.violations)
  ) {
    throw new Error('verifyEvidenceBundle: malformed residency block');
  }
  const byJurisdictionSrc = res.byJurisdiction as Record<string, unknown>;
  const byJurisdiction: Record<string, number> = {};
  for (const [k, n] of Object.entries(byJurisdictionSrc)) {
    if (!isCount(n)) {
      throw new Error('verifyEvidenceBundle: residency byJurisdiction has an invalid count');
    }
    byJurisdiction[k] = n;
  }
  const violations = res.violations.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('verifyEvidenceBundle: malformed residency violation');
    }
    const v = entry as Record<string, unknown>;
    if (!isString(v.tenantId) || !isString(v.region) || !isString(v.reason)) {
      throw new Error('verifyEvidenceBundle: malformed residency violation');
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

/** Validate + rebuild the audit excerpt (a newest-first array of redacted entries). */
function reconstructAuditExcerpt(value: unknown): ComplianceAuditEntry[] {
  if (!Array.isArray(value)) {
    throw new Error('verifyEvidenceBundle: malformed auditExcerpt (expected an array)');
  }
  return value.map(reconstructAuditEntry);
}

/** Validate + rebuild one redacted audit entry (optional actor/tenantId included only when present). */
function reconstructAuditEntry(value: unknown): ComplianceAuditEntry {
  if (typeof value !== 'object' || value === null) {
    throw new Error('verifyEvidenceBundle: malformed audit entry');
  }
  const e = value as Record<string, unknown>;
  if (!isString(e.at) || !isString(e.event) || (e.outcome !== 'ok' && e.outcome !== 'error')) {
    throw new Error('verifyEvidenceBundle: malformed audit entry');
  }
  let actor: ComplianceAuditEntry['actor'];
  if (e.actor !== undefined) {
    if (typeof e.actor !== 'object' || e.actor === null) {
      throw new Error('verifyEvidenceBundle: malformed audit entry actor');
    }
    const ac = e.actor as Record<string, unknown>;
    if (!isString(ac.id) || !isString(ac.role)) {
      throw new Error('verifyEvidenceBundle: malformed audit entry actor');
    }
    actor = { id: ac.id, role: ac.role };
  }
  if (e.tenantId !== undefined && !isString(e.tenantId)) {
    throw new Error('verifyEvidenceBundle: malformed audit entry tenantId');
  }
  return {
    at: e.at,
    event: e.event,
    outcome: e.outcome,
    ...(actor !== undefined ? { actor } : {}),
    ...(e.tenantId !== undefined ? { tenantId: e.tenantId } : {}),
  };
}

/** Validate + rebuild the per-artifact content-hash map (every field a hex string). */
function reconstructContentHashes(value: unknown): EvidenceContentHashes {
  if (typeof value !== 'object' || value === null) {
    throw new Error('verifyEvidenceBundle: malformed contentHashes block');
  }
  const h = value as Record<string, unknown>;
  if (
    !isString(h.inventory) ||
    !isString(h.isolation) ||
    !isString(h.residency) ||
    !isString(h.auditExcerpt) ||
    !isString(h.erasureCertificates)
  ) {
    throw new Error('verifyEvidenceBundle: malformed contentHashes block');
  }
  return {
    inventory: h.inventory,
    isolation: h.isolation,
    residency: h.residency,
    auditExcerpt: h.auditExcerpt,
    erasureCertificates: h.erasureCertificates,
  };
}
