# ADR 0011 — Compliance & governance evidence layer

- **Status:** Accepted (2026-06-25) — Phase 0 (design + threat model) + Phase 1 (signed compliance
  report) + Phase 2 (evidence bundle assembly + sign + verify, fleet + per-tenant) + **Phase 3a
  (evidence-at-rest persistence: `EvidenceStore` + manifest index + retention + generate webhook)**
  implemented; the **access-controlled retrieval surface (CLI/HTTP/MCP + public-key endpoint) is Phase
  3b** and the **dashboard panel is Phase 3c** (neither built here)
- **Relates to:** [ADR-0010](0010-self-scoped-customer-portal-write-surface.md) (the EdDSA signing
  primitive this reuses), [ADR-0001](0001-database-per-tenant-physical-isolation.md) (physical isolation),
  [ADR-0004](0004-secret-and-money-ops-off-the-agent-surface.md) (surface gating)
- **Scope doc:** `docs/research/compliance-evidence-layer-plan.md`

## Context

Neon gives the _isolation primitive_ (project-per-tenant) and markets it for SOC2/HIPAA, but stops
there. The defensible product is the **policy + evidence** layer on top: provable erasure, enforced
residency, attributable audit, proof-of-isolation — assembled into a **signed, timestamped,
auditor-consumable** artifact. This is **evidence** (queryable, verifiable facts), **not** a legal
certification.

A large fraction already ships: the fleet `complianceReport()` (`core/compliance.ts`) emits
proof-of-isolation, residency attestation, an audit excerpt, and a SHA-256 integrity digest; ADR-0010
added the `CertificateSigner` (EdDSA/Ed25519 JWS) for erasure certificates. The net-new work is to
**sign + bundle + persist + scope + retrieve**. The key gap this ADR's first slice closes: a bare
SHA-256 digest only proves integrity _if you already trust its source_; an **EdDSA JWS** is
**independently verifiable** by an auditor holding only the public key. Verification is the product.

## Decision

Build the compliance evidence layer in phases, reusing the existing attestation builders + the
ADR-0010 signing primitive. The five design decisions are **locked** (owner: john, 2026-06-25):

1. **v1 granularity — phased.** Sign the existing **fleet** report first (Phase 1, this slice), then
   add **per-tenant** evidence bundles (Phase 2).
2. **Persistence — persisted** to the object-store (evidence-at-rest + retention); auditors need
   durable, retrievable evidence. (Phase 3.)
3. **Signing key — reuse the `CertificateSigner` mechanism** (EdDSA/Ed25519 via `jose`) with a
   **distinct `kid`/purpose** for evidence vs erasure certs. KMS-backed signing stays the deferred
   future (the engine depends on the port abstraction, not the in-process key).
4. **Framework mapping — framework-agnostic facts** for v1 ("evidence, not certification");
   SOC2/GDPR/HIPAA control-mapping is a later layer.
5. **Customer-facing? — operator-only** (CLI/HTTP) v1; the portal self-serve "download my evidence"
   (self-scoped) is deferred to a later phase.

### Phase 1 (implemented in this slice)

- **`SignedComplianceReport`** — the fleet compliance report emitted as an **EdDSA (Ed25519) compact
  JWS** over the **same canonical report JSON** the SHA-256 digest already covers (a test pins
  byte-identity). The digest is retained alongside the JWS for backward compatibility; the **JWS is
  the new authenticity anchor**.
- **Distinct artifact class.** The JWS protected header uses a **distinct `typ`**
  (`application/compliance-report+jws`) and a distinct `kid` (`tenantforge-compliance-report`) from
  the erasure certificate (`application/erasure-cert+jws`), so the two cannot be confused under the
  same key (cross-type confusion — std-cwe). This is enforced by a new `ComplianceReportSigner` port +
  `createEd25519ComplianceReportSigner` adapter that **reuses the shared Ed25519 key-import mechanism**
  but signs the report claim under the compliance `typ`/`kid`.
- **`verifyComplianceReport(jws, publicKeyJwk)`** — a pure, **alg-pinned (`EdDSA`)**, **fail-closed**,
  deterministic verifier that mirrors `verifyErasureCertificate` exactly: it rejects
  `alg:none`/`HS*`/non-EdDSA, requires the compliance `typ` (so an erasure-cert JWS does **not**
  verify), refuses a non-Ed25519 or private key, and allow-list-validates the report shape (no
  coercion). Returns the parsed report on success; throws otherwise.
- **Always-signed discipline (mirrors ADR-0010).** `signedComplianceReport()` **fails closed**
  without a signer (no unsigned "signed report" path). Production **requires**
  `TENANTFORGE_COMPLIANCE_SIGNING_KEY` (config `superRefine` + a defense-in-depth re-check in
  `buildComplianceReportSigner`); non-prod with no key generates an **ephemeral** keypair (warned;
  not verifiable across restarts). The plain, unsigned `complianceReport()` (digest-only) is
  **unchanged** — existing callers that don't need a signature are not regressed and need no key.
- **Public-key publication.** `TenantForge.complianceReportPublicKey()` exposes the public Ed25519
  JWK for auditors (distinct from `erasureCertificatePublicKey()`).

### Phase 2 (implemented in this slice)

- **`EvidenceBundle`** (pure core type, `core/evidence-bundle.ts`):
  `{ scope: 'fleet' | 'tenant', tenantId?, generatedAt, artifacts: { inventory, isolation, residency,
auditExcerpt, erasureCertificates: string[] }, contentHashes }`. A single, auditor-consumable pack
  assembling the **same** isolation/residency/inventory attestations the fleet compliance report uses
  — the shared builders (`inventoryByStatus`, `buildIsolationAttestation`, `buildResidencyAttestation`,
  `auditEntries`) were **extracted from `buildComplianceReport`** so there is one redaction +
  attestation path, not two divergent ones (DIP — `@rules/topic-architecture-patterns.md`).
- **`buildEvidenceBundle(...)`** — **pure** (no I/O, injected `now`). Supports **fleet** and
  **per-tenant** scope; per-tenant **filters every artifact** (inventory, attestations, audit excerpt,
  and embedded certs) to the one **server-derived** `tenantId`. It **fails closed** on an ambiguous
  request (tenant scope without an id, fleet scope with one, or a scoped tenant not in the registry —
  never emit an empty/misleading per-tenant "all clear"). The per-tenant scoping is a
  **BOLA-sensitive boundary** even though the _retrieval surface_ is Phase 3 — the **content** is
  scoped here so a tenant bundle can never carry another tenant's facts.
- **Nested signed erasure certificates — folded in, not re-signed.** The bundle embeds the
  already-signed erasure-certificate **JWS strings** as **opaque, independently verifiable** nested
  artifacts. They keep their own EdDSA signature + `typ` and remain verifiable on their own via
  `verifyErasureCertificate`; the bundle signature additionally covers their bytes, so a
  swapped/tampered embedded cert breaks **bundle** verification (tamper-evident). The bundle builder
  never parses or re-signs them.
- **`contentHashes`** — a SHA-256 (hex) over each artifact's canonical JSON, so a consumer can
  spot-check individual parts (consistent with the report's existing digest approach). The bundle's
  EdDSA signature still authenticates the whole.
- **`verifyEvidenceBundle(jws, publicKeyJwk)`** — pure, **alg-pinned (`EdDSA`)**, **fail-closed**,
  deterministic; **mirrors `verifyComplianceReport`/`verifyErasureCertificate` exactly**. Distinct
  `typ` `application/evidence-bundle+jws` + `kid` `tenantforge-evidence-bundle`. It allow-list
  reconstructs **every** block (and enforces the scope ↔ `tenantId` invariant — a fleet bundle bearing
  a tenant id, or a tenant bundle missing one, is rejected). It verifies the **bundle envelope**;
  embedded certs are verified separately by the consumer.
- **Signer-key decision (recorded per the locked-decision requirement).** The bundle **reuses the
  existing compliance evidence signing key** (`config.complianceSigningKey` /
  `TENANTFORGE_COMPLIANCE_SIGNING_KEY`) via a **distinct `EvidenceBundleSigner` port** +
  `createEd25519EvidenceBundleSigner` adapter (the Phase-1 per-artifact-port precedent). **Rationale:**
  the bundle is part of the **same evidence layer** as the signed report; adding a third prod-required
  key would be needless key proliferation and operational burden. The two purposes are kept
  unambiguous by the **distinct `typ`/`kid`** the verifier pins (the cross-type-confusion
  discriminator — std-cwe), proven by cross-type abuse tests in both directions. ADR-0011's locked
  decision #3 ("reuse the `CertificateSigner` _mechanism_ with a distinct `kid`/purpose") is honored:
  the **mechanism** (Ed25519 via `jose`, shared key-import) is shared; the **purpose** is distinct.
- **Always-signed / fail-closed (mirrors Phase 1).** `TenantForge.evidenceBundle({ scope, tenantId? })`
  **fails closed** without a signer (no unsigned bundle path). Production **requires** the compliance
  key (validated at startup via `buildEvidenceBundleSigner`, a defense-in-depth re-check independent of
  `loadConfig`); non-prod with no key uses an **ephemeral** key (warned; not verifiable across
  restarts). `evidenceBundlePublicKey()` exposes the public JWK (equal to
  `complianceReportPublicKey()` since the key is shared — exposed separately for clarity of purpose).
- **No new HTTP/CLI/MCP/dashboard surface in this slice** — the facade method is added so the assembly
  - signing is testable now; the retrieval surface + access control are Phase 3.

### Phase 3a (implemented in this slice — persistence foundation)

- **`EvidenceManifest`** (pure core, `core/evidence-manifest.ts`) — the **queryable index record** for
  a persisted bundle: `{ bundleId, scope, tenantId?, generatedAt, storedAt, signerKid, contentHashes,
retentionUntil? }`. **Facts only** — never the JWS body, never secrets/connection URIs (master §5),
  the same discipline as the bundle it indexes. Retention math is pure (`evidenceRetentionUntil`,
  `isEvidenceExpired`) so every adapter agrees on eligibility (mutation-tested — `stryker.config.mjs`).
- **`EvidenceStore` port** (`ports/evidence-store.ts`) — `put(signed, opts) → EvidenceManifest`,
  `get(bundleId, tenantScope) → SignedEvidenceBundle | null`, `list(filter) → EvidenceManifest[]`,
  `pruneExpired(now, limit?) → number`.
  - **Non-guessable, tenant-scoped keys.** A `bundleId` is **128 bits of CSPRNG entropy**
    (`mintEvidenceBundleId`), **never sequential/predictable** — a stored bundle can't be enumerated
    by guessing ids (the **F7/L3 lesson**). For a per-tenant bundle the manifest's `tenantId` (taken
    from the bundle's own server-derived id) makes the key/index tenant-scoped, so **Phase 3b's authz
    can enforce ownership** (BOLA on fetch).
  - **Access control is enforced at the 3b surface, not the store (BOUNDARY NOTE).** This port is a
    **low-level capability**: `get`/`list` exist so 3b can be built on it, but in this slice they are
    **not surfaced outward** (no CLI/HTTP/MCP read of a bundle). The store does **not decide who may
    ask** — that is 3b's job. To stop 3b accidentally bypassing per-tenant ownership, `get` **still
    takes a `tenantScope` argument**: a tenant-scoped fetch (`tenantScope = <tenantId>`) returns a
    bundle iff it is that tenant's; `tenantScope = null` is the operator/fleet scope. A tenant-scoped
    fetch of another tenant's (or a fleet) bundle returns `null` — the store-level half of BOLA
    defense (complete mediation / defense in depth, even though the store doesn't authorize).
- **Adapters.** An **in-memory** store (`adapters/evidence-store.ts`; dev/test, mirrors the
  pending-erasure memory store) and an **object-store-backed** store
  (`adapters/object-store-evidence-store.ts`) built on the **existing `ObjectStore` port** — the same
  seam the off-Neon archive tier uses. It writes the signed bundle body durably at rest under a
  **non-guessable, tenant-scoped key** (`{prefix}/{tenant|fleet}/{bundleId}.jws.json`) and keeps the
  manifest index for `get`/`list`/`pruneExpired`. **Encrypt-at-rest is the object store's concern**
  (S3/GCS SSE / KMS-backed bucket / encrypted volume) — the body carries no secrets regardless.
  Config-selected via **`TENANTFORGE_EVIDENCE_STORE`** (`memory` default; `object-store` requires
  `TENANTFORGE_EXPORT_DIR`), mirroring `TENANTFORGE_PENDING_ERASURE_STORE`. (The `ObjectStore` port is
  **write-only** (`put`) — the archive-tier precedent where retrieval is the store's own
  console/lifecycle — so this adapter keeps the index + a body copy in-process and writes the body
  durably; a future read-capable object-store port, or a Postgres manifest index mirroring the
  pending-erasure pg adapter, can make `get`/`list` survive a restart from the durable objects alone.)
- **Persist-on-generate (deliberate, fail-closed).** `TenantForge.evidenceBundle(...)` now returns the
  persisted **`manifest`** alongside `{ bundle, jws }` when an evidence store is wired (additive —
  **non-breaking**: callers reading `{ bundle, jws }` are unaffected). **Without a store, generation
  still succeeds** (returns the signed bundle, `manifest` omitted) and does **not** silently claim
  persistence (master §2 — explicit, never implicit). With a store, a **persist failure fails the
  call** (fail closed — an auditor must not believe a bundle is durably stored when it is not).
- **Retention.** A default window (`TENANTFORGE_EVIDENCE_RETENTION_DAYS`, `0` ⇒ **indefinite** — the
  conservative data-lifecycle default for evidence) sets each manifest's `retentionUntil`.
  `TenantForge.evidencePrune(...)` is the scheduled retention sweep (idempotent, batched), wired
  alongside the existing sweeps (`purgeExpired`/`erasureSweep`). A persistence-side **CLI
  `evidence-prune`** (Phase 3b/ops wiring) is the acceptable persistence-side surface — there is **no
  retrieval CLI** here. (Object-store body deletion is the object store's own lifecycle policy — the
  write-only port exposes no delete, exactly as the archive tier documents.)
- **Generate webhook.** Persisting emits a `compliance.evidence_bundle_persisted` event that fans out
  to managed webhook subscriptions via the **existing webhooks port** (mirroring erasure/DSAR
  notifications). The payload is **manifest facts only** (`bundleId`/`scope`/`tenantId`/`generatedAt`/
  `storedAt`/`retentionUntil`) — **never the bundle body or any secret** (master §5).

### Deferred (Phase 3b / 3c — not built here)

- **Phase 3b — retrieval surface + access control.** CLI/HTTP retrieval of a stored bundle
  (operator-only v1, **no cross-tenant** — BOLA on _fetch_; the _content_ is scoped from Phase 2 and
  the _key/index_ from Phase 3a), MCP read-only, and the **public-key publication endpoint**. The
  access-control decision (which scope a caller gets) lives here — the Phase 3a store only enforces the
  scope it is **told** to (`get(bundleId, tenantScope)`). **Deferred and confirmed out of scope here.**
- **Phase 3c — dashboard panel.** The human-facing web view of stored evidence (per the per-feature
  dashboard rule). **Deferred and confirmed out of scope here.**

## Alternatives considered

- **Keep the SHA-256 digest only** — rejected: a digest is an integrity anchor an auditor can only
  trust if they trust the channel/source; it is not independently verifiable. The signature is the
  product.
- **Overload the erasure `CertificateSigner.sign()` to also sign reports** — rejected: conflates two
  artifact purposes under one method and risks cross-type confusion. Instead a **distinct port** with
  a distinct `typ`/`kid` reuses the same key-import + Ed25519 mechanism (DIP — the mechanism is shared,
  the purposes are not).
- **Replace the unsigned `complianceReport()` outright** — rejected for this slice: callers consuming
  the digest-only result (dashboard panel, CLI, MCP) keep working; `signedComplianceReport()` is
  **additive**. Phase 2/3 can revisit promoting the signed form to the default surface.
- **Per-tenant / persisted / portal in v1** — deferred per the locked phasing (smallest high-value
  step first: immediate auditor-verifiability over what already exists).
- **A separate `TENANTFORGE_EVIDENCE_SIGNING_KEY` for the bundle (Phase 2)** — rejected: the bundle is
  the same evidence layer as the signed report and the verifier already pins a distinct `typ`/`kid`, so
  a third prod-required key adds key-management burden with no security gain. The bundle **reuses the
  compliance key** (locked decision #3 honored at the _mechanism_ level). A KMS/HSM signer can still
  drop in behind the `EvidenceBundleSigner` port later.
- **Re-signing the embedded erasure certificates inside the bundle (Phase 2)** — rejected: each erasure
  certificate is already an independently verifiable artifact; re-signing would (a) couple the bundle
  to the erasure key, (b) hide which key actually attested the erasure, and (c) gain nothing the bundle
  signature-over-bytes doesn't already give (tamper-evidence). The certs are folded in **opaque**.

## Consequences

- Auditors can verify a fleet compliance report **and a fleet/per-tenant evidence bundle** **offline
  with only the public key** — the verification-is-the-product requirement is met for both today.
- **Phase 2 new surface:** `core/evidence-bundle.ts` (`buildEvidenceBundle`, `verifyEvidenceBundle`,
  `evidenceBundleClaims`, the `EvidenceBundle`/`SignedEvidenceBundle` types), an `EvidenceBundleSigner`
  port + `createEd25519EvidenceBundleSigner` adapter (reusing the shared Ed25519 key-import), the
  `TenantForge.evidenceBundle({ scope, tenantId? })` + `evidenceBundlePublicKey()` facade methods, and
  `buildEvidenceBundleSigner` in the composition root (reuses the compliance key, prod fail-fast). The
  shared attestation builders were extracted from `compliance.ts` (no behavior change to the report).
- **Three** signed artifact classes now share one key mechanism but are **never confusable** (erasure
  certificate / compliance report / evidence bundle — each a distinct `typ`/`kid`, verifier-enforced;
  pinned by cross-type abuse tests in **both** directions). Every signed payload carries **attestation
  facts only** — no secrets, no connection URIs, a PII-minimized/redacted audit excerpt (master §5).
- Auditors can verify a fleet compliance report **offline with only the public key** — the
  verification-is-the-product requirement is met for the fleet report today.
- New surface: a `ComplianceReportSigner` port + Ed25519 adapter, `signedComplianceReport()` /
  `complianceReportPublicKey()` facade methods, `verifyComplianceReport` / `complianceReportClaims`
  pure-core functions, and `TENANTFORGE_COMPLIANCE_SIGNING_KEY` config (prod-required, fail-fast).
- The two signed artifact classes (erasure certificate, compliance report) share a key mechanism but
  are **never confusable** (distinct `typ`/`kid`, verifier-enforced; pinned by a cross-type abuse
  test). The signed report carries **attestation facts only** — no secrets, no connection URIs, a
  PII-minimized/redacted audit excerpt (master §5; threat model below).
- Revisit when **Phase 3** lands (persistence via an `EvidenceStore`, the retrieval surface + BOLA-safe
  access control on _fetch_, the public-key endpoint, a generate webhook, the dashboard panel). A
  KMS/HSM signer can drop in behind the same ports later.
- **Dashboard parity (per-feature web-view rule).** The fleet compliance report already has a
  dashboard `CompliancePanel`; this slice upgrades the _integrity anchor_ of an existing feature
  (additive backend) rather than introducing a net-new user-facing feature, so the panel is amended
  (surfacing verifiability/public-key) as Phase 3 grows the surface — it does not require a new panel
  for the signature itself.
