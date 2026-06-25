# TenantForge — Compliance & Governance Evidence Layer (scope)

> **Status: scope draft (2026-06-25).** The pivot-directions #1 recommended core
> (`docs/research/pivot-directions.md` §3): "make your Neon database-per-tenant fleet **audit-ready**."
> This scopes it. Nothing here is implemented yet; `main` is unaffected until feature branches land.
>
> **Key finding — this is mostly assembly, not greenfield.** A large fraction of the vision already
> ships as the fleet `complianceReport()`, and #180 added the signing primitive. The net-new work is
> **sign + bundle + persist + per-tenant + retrieve**, plus access control.

## Thesis

Neon gives the _isolation primitive_ and even markets it for SOC2/HIPAA, but stops there. The
defensible product is the **policy + evidence** layer on top: provable erasure, enforced residency,
attributable audit, proof-of-isolation — assembled into a **signed, timestamped, auditor-consumable
evidence bundle** per tenant or per fleet. Evidence (queryable, verifiable facts), **not** a legal
certification.

## What already exists (the reuse — be specific)

- **`complianceReport()`** (`core/compliance.ts` `buildComplianceReport` + the facade) already emits a
  fleet `ComplianceReport`:
  - **Proof-of-isolation** — each live tenant has its own Neon project; detects `sharedProjects`
    (cross-tenant violation) + `missingProject`. ✅
  - **Residency attestation** — region→jurisdiction mapping, org allow-list, `violations`. ✅
  - **Audit evidence** — erasure history (transitions→`deleted`) + a recent control-plane excerpt
    (when an audit store is wired). ✅
  - **Integrity anchor** — a SHA-256 digest over the canonical report JSON. ✅
  - Surfaced on **HTTP `/v1/compliance/report`, CLI, MCP, and the dashboard `CompliancePanel`**.
- **Signed erasure certificate** (#180) — `CertificateSigner` port + EdDSA/Ed25519 JWS +
  `verifyErasureCertificate`. The **signing primitive the bundle reuses**. ✅
- **Audit stream** (`observe`/`emit` → audit-log store, redacted, operator-attributed), **audit-query**
  (bounded), **audit-anomaly**, **retention-report**, **residency-router**, **object-store** port
  (evidence-at-rest), **webhooks** (notify on erasure/DSAR). ✅

## The gap (net-new — what the evidence layer adds)

1. **Sign the compliance report, don't just digest it.** A bare SHA-256 digest only proves integrity
   if you trust its source; an **EdDSA JWS** (reuse `CertificateSigner`) is **independently verifiable**
   by an auditor with the public key. Upgrade the report's integrity anchor to a signature.
2. **Evidence bundle** — a signed, timestamped pack assembling, for a **tenant** (or the **fleet**):
   the signed erasure certificate(s), the residency attestation, the isolation proof, and a scoped
   audit excerpt — as **one** auditor-consumable artifact with a manifest. The compliance report is
   fleet-level + ephemeral; the bundle is **scoped, persisted, retrievable**.
3. **Per-tenant evidence** — today only a fleet report exists; an enterprise customer's security review
   wants **their** tenant's evidence.
4. **Evidence at rest + provenance** — persist bundles to the **object-store** with a manifest/index
   (bundle id, scope, generatedAt, signer key id, content hashes), retention per policy; a webhook on
   generation/erasure.
5. **Retrieval surface + access control** — fetch a bundle (operator via CLI/HTTP; optionally the
   tenant their own via the **portal**), strictly scoped (no cross-tenant — BOLA), with the public key
   published for verification.

## Proposed design

- **`EvidenceBundle`** (pure core type): `{ scope: 'tenant'|'fleet', tenantId?, generatedAt, artifacts:
{ isolation, residency, auditExcerpt, erasureCertificates[] }, contentHashes }`. Built by a pure
  `buildEvidenceBundle(...)` (functional core), assembling the existing attestation builders.
- **Signing**: a `SignedEvidenceBundle` = the bundle as an **EdDSA JWS** via the `CertificateSigner`
  port (reuse #180; likely a **distinct key purpose**/kid from the erasure cert — decision below).
  `verifyEvidenceBundle(jws, publicKeyJwk)` (pure, alg-pinned EdDSA, fail-closed — mirror
  `verifyErasureCertificate`).
- **Persistence**: an `EvidenceStore` (object-store-backed) — `put(bundle) -> ref`, `get(ref)`,
  `list(scope)`; tenant-scoped, non-guessable keys (the F7/L3 lesson). Retention via the existing
  data-lifecycle.
- **Surfaces**: CLI `evidence-bundle [--tenant <id>] [--verify]`, HTTP `GET /v1/evidence/...`
  (operator), the public key endpoint; optionally a portal "download my compliance evidence" action
  (self-scoped). MCP: **read-only** (per ADR-0004 money/secret stays off-agent; evidence is read-only
  facts, so a read tool is fine — confirm).

## Phasing

- **Phase 0 — design + threat model.** STRIDE the evidence boundary: the bundle is a
  **confidential** artifact (tenant ids, residency, audit) — classify it, access-control retrieval
  (no cross-tenant — BOLA), PII-minimize the audit excerpt (redaction already exists), key management
  for the signing/verification key. Record an ADR (evidence layer; relation to ADR-0010's signing).
- **Phase 1 — sign the existing compliance report.** Reuse `CertificateSigner` to emit a
  `SignedComplianceReport` (JWS) alongside/replacing the digest; add `verifyComplianceReport`. Smallest
  high-value step — immediate auditor-verifiability on what already exists.
- **Phase 2 — evidence bundle assembly + verify.** Pure `buildEvidenceBundle` (fleet + per-tenant),
  fold in the signed erasure certs, sign the bundle, `verifyEvidenceBundle` + tests/abuse tests.
- **Phase 3 — persistence + retrieval + surfaces.** `EvidenceStore` (object-store), CLI/HTTP retrieval
  (tenant-scoped), public-key publication, optional portal self-serve download, webhook on generate,
  retention. Docs/runbook + the dashboard panel (per-feature-dashboard rule).

## Security / threat (Phase 0 will formalize)

- **Confidential artifact**: classify; encrypt at rest (object-store); access-controlled retrieval;
  **no cross-tenant** (tenant-scoped, server-derived id — BOLA). **No secrets/connection URIs** in a
  bundle (it carries attestation facts + signed certs only); PII-minimize the audit excerpt.
- **Signing key**: reuse the `CertificateSigner` (KMS-signing still the deferred future); publish the
  **public** key for verification; a distinct kid/purpose for evidence vs erasure certs.
- **Verification is the product**: an auditor must verify a bundle **offline** with only the public
  key — alg-pinned, fail-closed, deterministic.

## Locked decisions (2026-06-25 — owner: john)

1. **v1 granularity** — **phased**: sign the existing **fleet** report first (Phase 1), then add
   **per-tenant** bundles (Phase 2). ✅ LOCKED
2. **Persistence** — **persisted** to the object-store (evidence-at-rest + retention); auditors need
   durable, retrievable evidence. ✅ LOCKED
3. **Signing key** — **reuse the `CertificateSigner` port** with a **distinct `kid`/purpose** for
   evidence vs erasure certs (KMS-backed signing stays the deferred future). ✅ LOCKED
4. **Framework mapping** — **framework-agnostic facts** for v1 ("evidence, not certification");
   SOC2/GDPR/HIPAA control-mapping is a later layer. ✅ LOCKED
5. **Customer-facing?** — **operator-only** (CLI/HTTP) v1; the portal self-serve "download my
   evidence" (self-scoped) is deferred to a later phase. ✅ LOCKED

## Reuse scorecard

Highest of any pivot direction: isolation proof, residency attestation, audit stream + query,
erasure + **signed** certificate, object-store, webhooks, the `CertificateSigner` signing primitive,
data-lifecycle/retention — all already present. The layer **assembles + signs + persists + scopes**
them; the genuinely new code is the bundle type/builder, the bundle signer/verifier, the
`EvidenceStore`, and the retrieval surface.
