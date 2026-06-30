# TenantForge — Threat Model (STRIDE)

> Design-time threat model for the TenantForge control plane (`@rules/workflow-threat-model.md`).
> TenantForge's defining security property is **tenant isolation**: a cross-tenant data leak is a
> SEV1 (`docs/runbooks/incident-response.md`). Revisit this model when a trust boundary, the auth
> model, a data flow, or an external interface changes.

## System & data-flow

TenantForge is a control plane that provisions an **isolated Neon project per tenant** and brokers
the lifecycle. It holds **metadata only** (the `tf_*` registry tables) — never tenant content.

```
 operator ──HTTPS+token──▶ HTTP API (Hono) ─┐
 LLM/agent ──stdio──────▶ MCP server ───────┤
 ops CLI ────────────────────────────────────┼─▶ core (pure) ──▶ ports ──▶ adapters
 queue producer ─▶ tf_lifecycle_queue ─▶ worker/consumer ─┘                 │
                                                                            ├─▶ Neon API (provision/delete/usage)   [untrusted upstream]
                                                                            ├─▶ control-plane Postgres (registry)   [metadata only]
                                                                            ├─▶ SecretStore (neon-pg enc / Vault)   [per-tenant URIs]
                                                                            └─▶ tenant Neon projects                [physically isolated]
```

**Data classification** (master §5): connection URIs + Neon/registry credentials = **restricted**;
tenant metadata (slug, region, status) = **confidential**; export artifacts = **restricted** (tenant
data). No tenant content is stored in the control plane.

## Trust boundaries

| #   | Boundary                                           | Crossing                                            |
| --- | -------------------------------------------------- | --------------------------------------------------- |
| B1  | Internet/operator → HTTP control-plane API         | admin requests over the network                     |
| B2  | LLM/agent → MCP server                             | tool calls from an autonomous agent                 |
| B3  | Application → connection routing (`getConnection`) | resolve a tenant's DB connection                    |
| B4  | Tenant ↔ tenant                                    | the core isolation guarantee                        |
| B5  | Service → Neon API                                 | calls to an external upstream                       |
| B6  | Queue producer → lifecycle consumer                | untrusted command payloads                          |
| B7  | Service → SecretStore / registry / object store    | secret + metadata persistence                       |
| B8  | Tenant (customer) → self-serve portal              | a tenant reads its own account data                 |
| B12 | Public internet → self-serve signup/onboarding     | an unauthenticated stranger provisions a new tenant |

## STRIDE per boundary → mitigation (and where it lives in code)

### B1 — HTTP control-plane API (admin)

- **S (spoofing):** authentication is behind the `Authenticator` port (`src/ports/authenticator.ts`),
  resolved server-side to a principal `{ id, role }`. Two modes (`TENANTFORGE_AUTH_MODE`): **`token`**
  — per-operator bearer credentials (`id:role:token`) with **constant-time** token compare
  (`src/adapters/auth/token-authenticator.ts`), tokens are secrets from env (`workflow-secrets`),
  rotatable (`docs/runbooks/secret-rotation.md`), with a single-admin shorthand for simple deploys; or
  **`oidc`** — a Bearer **JWT** verified against an external issuer's JWKS via `jose`
  (`src/adapters/auth/oidc-authenticator.ts`): signature + `iss`/`aud`/`exp` checked, algorithm
  constrained to an asymmetric allow-list (rejects `alg:none`/`HS*` confusion), id+role from the
  `sub`/`role` claims — phishing-resistant, externally-managed identity, no shared secrets.
  **AuthZ (RBAC, API5):** mutating routes require the `admin` role; `readonly` → 403 (mode-independent).
- **T (tampering):** request bodies validated with `zod` before use; TLS terminated at the edge
  (deploy concern). **I (disclosure):** the API **never returns connection URIs** — `provision`
  reports only that a secret was issued; errors return a stable shape, not internals
  (`@rules/topic-error-handling.md`). **R (repudiation):** structured, tenant-scoped audit events
  (`src/core/observability.ts`) carry an **operator `actor` { id, role }** (who-did-what-when),
  threaded from the authenticated principal via a request-scoped context (`src/app/actor-context.ts`).
  **D (DoS):** a 1 MB request
  **body-size cap** + a **per-principal fixed-window rate limit** (429 + `Retry-After`) are enforced
  in-app (`src/app/http-server.ts`). **E (EoP):** this is an _admin_ control plane: the
  `:id` is operator-supplied by design (not a tenant impersonating another); least-privilege token +
  network ACLs gate it. **Fine-grained RBAC** enforces a required permission per operation
  server-side, deny by default (`src/core/authz.ts`): `operator` runs the reversible lifecycle but
  cannot `tenant:purge`, so the irreversible op needs an `admin` (or an explicitly-granted) token.
  The destructive purge route additionally requires an explicit `confirm: true`.

### B2 — MCP server (agent)

- **E / excessive agency (LLM08):** the irreversible **`purge` / `purge-expired` are not exposed as
  MCP tools** — destructive hard-deletes stay on the human-driven CLI/HTTP plane (defense in depth).
  Verified by an abuse test (`test/app/mcp.test.ts`). Tool inputs are validated; tool output is data.

### B3 — Connection routing / BOLA (the #1 API risk)

- **E / BOLA:** `getConnection(id)` resolves **only** for the given tenant and **fails closed** —
  `assertRoutable` (`src/core/routing.ts`) admits a tenant **only** when `status === 'active'` **and**
  a project is provisioned; every other status (`provisioning`/`suspended`/`offboarding`/`deleted`)
  is rejected. The tenant id is **server-derived by the caller, never client-supplied**
  (`@rules/std-owasp-api.md` API1). A denied resolution emits `tenant.connection_denied` (no URI).

### B4 — Tenant ↔ tenant isolation (the core guarantee)

- **I / cross-tenant leak:** isolation is **physical** — one Neon project per tenant, so there is no
  shared-schema `WHERE tenant_id` that a bug could omit. The registry, SecretStore, and queue are all
  keyed by tenant id; `getConnection(A)` can only ever return A's project/URI. This is the property
  the abuse suite pins (cross-tenant no-bleed test). A leak here is SEV1.

### B5 — Neon API (untrusted upstream)

- **T/I/D:** every call has a **timeout**, a **schema-validated** response, and **bounded retries**
  (`src/adapters/neon-api/*`, `@rules/topic-api-consumption.md`); the API key is a secret, never
  logged. A compromised/abused key is SEV1 → revoke+rotate (`incident-response.md`).

### B6 — Queue payloads (untrusted input)

- **T/EoP:** `parseLifecycleCommand` validates every payload at the boundary; a malformed payload is
  **dead-lettered, never executed** (`src/adapters/lifecycle-consumer.ts`); delivery is at-least-once
  so handlers are idempotent and commands deduped by id. `purge` is **not** a queue command.

### B7 — Secrets, registry, object store

- **I:** connection URIs live in the **SecretStore** (AES-256-GCM-encrypted `neon-pg` or Vault),
  **not** the registry — so a control-plane DB compromise alone yields only metadata, not URIs
  (separation of duties, master §5). Secrets are **redacted** from logs/events/errors
  (`redactSecrets`). `delete` crypto-shreds on purge. The filesystem object store confines keys to
  its root (CWE-22). Per-tenant DB roles are least-privilege.

### B8 — Tenant self-serve portal (customer-facing)

- **S:** a tenant authenticates with a portal token (`TenantAuthenticator`, constant-time match);
  the session is a signed, HttpOnly, `SameSite=Strict` cookie minted server-side.
- **EoP / Information disclosure (the key threat — BOLA):** the portal derives the tenant id **only**
  from the session, **never** from request input — no route accepts a `tenantId` param, so a tenant
  cannot name another tenant (`src/app/portal.ts`). Reads go through tenant-scoped facade methods
  (`tenantCharges`/`tenantRefunds` are store-filtered; `tenantSummary` returns a safe projection that
  omits raw metadata / `billingCustomerRef` / infra ids). Pinned by a cross-tenant isolation test.
- **T:** a tampered/expired session cookie fails closed (HMAC verify + `exp`).
- **EoP (mutation):** the portal is **read-only** — no money movement or lifecycle actions; those
  stay on the operator/CLI surfaces (gated). **D:** the portal inherits the API's edge controls (TLS
  at the proxy, rate limiting); rendered output is HTML-escaped (XSS defence in depth).

### B8w — Tenant self-serve portal **write surface** — Phase 1 backend SHIPPED (2026-06-24)

> **Status: backend landed (Phase 1); destructive pair flag-gated OFF.** Implements the portal-SPA +
> self-serve feature backend (`docs/research/portal-spa-plan.md`). This **supersedes B8's "read-only"
> mitigation** for the listed actions: the portal is now a _write_ surface for a tenant's **own**
> account only (payment-method, plan change, cancel, data-export, erasure) via JSON `/portal/api/*`
> endpoints (`src/app/portal.ts`). It is a **deliberate relaxation of ADR-0004** (money/lifecycle off
> the customer surface), scoped to self and gated per action below. Cancel + erasure ship behind
> `TENANTFORGE_PORTAL_SELFSERVE_DESTRUCTIVE` (OFF) until security-reviewed (F6). All B8w abuse cases
> below are now pinned by tests (`test/app/portal-selfserve*.test.ts`,
> `test/adapters/{one-time-code,pending-erasure}-store.test.ts`). Phase 2 (SPA) + Phase 3 (a11y/docs)
> follow; promote B8w into B8 proper once the destructive flag flips on.

- **S (spoofing):** login via the **OIDC** `TenantAuthenticator` (decision #2) — Bearer JWT verified
  with `jose` (signature + `iss`/`aud`/`exp`, asymmetric-alg allow-list, tenant id from the claim
  **server-side**), exchanged for the existing signed, HttpOnly, `SameSite=Strict` session cookie.
  Pin the OIDC `state`+`nonce` **server-side** and verify at the login callback (the login POST is
  itself CSRF-able). **Step-up = a control-plane-owned second factor** for the two destructive
  actions (cancel, erasure): a single-use, short-TTL **email/TOTP code** verified server-side —
  **not** IdP `auth_time`/`iat` (a standard IdP can mint a fresh token via silent refresh /
  `prompt=none` with no human present — red-team F1). A stale session alone cannot trigger destruction.
- **T (tampering):** all state-changing requests are `zod`-validated **and CSRF-protected** — a
  **signed, session-bound CSRF token required in a custom header** (`X-TF-CSRF`), signed over
  `csrf:{tenantId}:{session-exp}` and verified against the **live** session, so it rotates with the
  cookie and **dies on expiry/logout** — a leaked token is not a forever-valid bypass (review L1); it
  is not a bare double-submit a subdomain/cookie-injection could forge, plus an
  `Origin`/`Sec-Fetch-Site` allow-list as defense-in-depth; `SameSite=Strict` is a backstop, not the
  control (red-team F4). Tampered/expired session → fail closed (HMAC + `exp`).
- **R (repudiation):** every mutation emits a tenant-scoped audit event via `observe(...)` with the
  **tenant principal as actor** (`tenant.plan_changed`, `tenant.payment_method_updated`,
  `tenant.offboarded` (self-serve), `tenant.export_requested`, `tenant.erasure_requested` /
  `tenant.erased`), secrets redacted.
- **I (disclosure):** responses keep the **safe projection** (no `billingCustomerRef`, infra ids, or
  connection URIs). Card capture uses **Stripe Elements** — the PAN never touches our server (PCI
  scope reduction); the server **verifies the SetupIntent** before setting a default, never trusting
  a client "success", **and checks `intent.customerRef === tenant.billingCustomerRef`** (read from the
  session tenant) so a SetupIntent for customer X can't be applied to tenant Y (PSP-side BOLA — red-
  team F5); fails closed when the tenant has no billing customer. The default is then set **at the
  PSP** (`PaymentSetup.setDefaultPaymentMethod` → Stripe `invoice_settings.default_payment_method`) —
  the field the off-session charge path actually reads — so an "update card" genuinely takes effect;
  success is reported only once the PSP set-default succeeds (review M1).
- **D (abuse-prone flows, API6):** **per-session + per-IP rate limits** on every mutation (reuse
  `RateLimitStore`), and **idempotency keys** on money ops (reuse `idempotency-store`) so retries
  can't double-charge / double-apply.
- **E (EoP / BOLA — still the key threat):** the tenant id is **still derived only from the
  session, never request input** — a mutation can only ever affect the **session tenant's own**
  account; no route accepts a `tenantId`. Money/lifecycle are now permitted **but self-scoped**.
  Cancel calls `offboard` (project **retained**, reversible) — **never** `purge`.
- **Irreversibility (erasure) — HARD REQUIREMENT:** a **mandatory undo window**. The erasure request
  is **scheduled, not executed synchronously**; the project is deleted only after the window elapses,
  and the customer can **cancel the pending request** until then. Typed confirmation + second-factor
  gate the _request_; the undo window guards the _execution_. **The tenant keeps serving during the
  window** (pending-erasure does **not** suspend routing — avoids a timer-delayed self-serve DoS,
  red-team F2). Cancel and execute are a **single atomic conditional update**
  (`UPDATE … SET status='processing' WHERE id=? AND status='pending'`); only the winner proceeds, so a
  cancel that races the executor cannot lose data, and an at-least-once redelivery of a non-`pending`
  record acks and exits (no re-export/re-delete). Default window 48h (config); window + execution ≤
  the statutory erasure SLA. Winner → verified-erasure engine → **cryptographically signed
  certificate** (EdDSA/Ed25519 compact JWS via `jose`; alg pinned on verify, rejects
  `none`/`HS*`/non-EdDSA — CWE-347/T-tampering & R-repudiation). **Always-signed:** the signing key is
  validated at startup (prod requires `TENANTFORGE_ERASURE_SIGNING_KEY`; scheduling an erasure fails
  closed without a signer — never an erased-but-unsignable tenant); a post-erasure signing failure
  **fails soft** (cert recorded unsigned + operator alerted, never rolled back). An auditor/data
  subject verifies the certificate offline against the published public JWK
  (`erasure-cert-verify` / `verifyErasureCertificate`). **Operator + the tenant's verified email are
  alerted** on schedule and on execution (griefing tripwire / wrong-account safety net).

### B9 — Signed compliance report (evidence artifact) — Phase 1 SHIPPED (2026-06-25)

> **Status: Phase 1 of the compliance evidence layer landed (ADR-0011).** The fleet
> `complianceReport()` (`core/compliance.ts`) is now **independently verifiable**: alongside the
> existing SHA-256 digest, `signedComplianceReport()` emits an **EdDSA (Ed25519) compact JWS** over
> the same canonical report JSON (`core/compliance-cert.ts`, `adapters/compliance-report-signer.ts`).
> The report is a **confidential** artifact (tenant ids, residency, an audit excerpt). STRIDE pass on
> that artifact below. **Out of scope here (Phase 2/3):** the evidence _bundle_, **per-tenant**
> scoping, persistence, and the **retrieval surface + access control** (BOLA on fetch) — those land
> later; this section covers only the signed-artifact boundary.

- **T (tampering) — the core threat:** the report's integrity/authenticity anchor is upgraded from a
  bare SHA-256 digest (proves bytes unchanged, but only if you trust the source) to an **EdDSA JWS**.
  Any tamper to the payload invalidates the signature; `verifyComplianceReport` fails closed. The JWS
  signs the **same canonical bytes** the digest covers (a test pins byte-identity), so the two anchors
  agree. (std-owasp #8 — software/data integrity; CWE-345/347.)
- **S / R (spoofing / repudiation):** signer authenticity rests on the **alg-pinned EdDSA**
  verification (rejects `alg:none`/`HS*`/any non-EdDSA — no alg-confusion, CWE-347) against the
  operator's **published public JWK**, and signer **identity/purpose** via a distinct protected-header
  `kid` (`tenantforge-compliance-report`) + `typ` (`application/compliance-report+jws`). A confused
  deputy cannot present a token minted for another purpose: an **erasure-certificate JWS does not
  verify as a compliance report** (distinct `typ`/`kid`; pinned by a cross-type abuse test). Signing
  is recorded via a `compliance.report_signed` audit event (non-repudiation).
- **I (information disclosure):** the report carries **attestation facts only** — inventory counts,
  isolation/residency booleans + offending ids, allow-list, and an **already-redacted** audit excerpt
  (`redactSecrets` upstream; the audit entries are PII-minimized to `at/event/outcome/actor/tenantId`).
  It contains **no secrets and no connection URIs** (master §5); a canonicalization test asserts the
  signed claim object never matches secret/connection patterns. Distribution/access-control of the
  artifact is a **Phase 3** concern (operator-only retrieval, then tenant-scoped — no cross-tenant
  BOLA); v1 is operator-only.
- **D (denial of service):** report assembly is a bounded registry read + a bounded audit query (the
  same caps the unsigned path already uses); signing is one EdDSA operation. No new unbounded surface.
- **E (elevation):** no privilege boundary is crossed by signing; the signer holds only its own
  private key. The signing key is **private**, from config/secret-manager, never logged
  (`@rules/workflow-secrets.md`); only the **public** JWK is exposed
  (`complianceReportPublicKey()`).
- **Always-signed / fail-closed:** `signedComplianceReport()` **fails closed** without a signer (no
  unsigned "signed report"). Production **requires** `TENANTFORGE_COMPLIANCE_SIGNING_KEY` (config
  `superRefine` + a defense-in-depth re-check in `buildComplianceReportSigner`); non-prod with no key
  uses an ephemeral key (warned; not verifiable across restarts). The unsigned `complianceReport()`
  (digest-only) is unchanged and needs no key.
- **Verification is the product (HARD REQUIREMENT):** an auditor must verify a report **offline with
  only the public key** — `verifyComplianceReport(jws, jwk)` is **pure, deterministic, alg-pinned, and
  fail-closed** (mirrors `verifyErasureCertificate`), allow-list-validating the report shape with no
  coercion. Any signature/alg/typ/key/shape failure throws; it never returns an unverified report.

### B10 — Evidence bundle (confidential, per-tenant-scoped artifact) — Phase 2 SHIPPED (2026-06-25)

> **Status: Phase 2 of the compliance evidence layer landed (ADR-0011).** A pure `buildEvidenceBundle`
> (`core/evidence-bundle.ts`) assembles the isolation proof, residency attestation, a PII-minimized
> audit excerpt, and the embedded **signed** erasure certificate(s) into one **signed**
> (`SignedEvidenceBundle`) artifact for either the whole **fleet** or a single **tenant**;
> `verifyEvidenceBundle` (alg-pinned EdDSA, distinct `typ` `application/evidence-bundle+jws`) verifies
> it offline with only the public key. The bundle is a **confidential** artifact (tenant ids,
> residency, an audit excerpt). STRIDE pass below. **Phase 3a (evidence-at-rest persistence) SHIPPED
> (2026-06-25)** — see the persistence addendum after the STRIDE pass. **Still out of scope (Phase
> 3b/3c):** the **retrieval surface + access control** (BOLA on _fetch_), the public-key endpoint, and
> the dashboard panel — those land later.

- **T (tampering) — the core threat:** the bundle's authenticity anchor is an **EdDSA JWS** over the
  canonical bundle JSON; any tamper invalidates the signature and `verifyEvidenceBundle` fails closed.
  Per-artifact **SHA-256 `contentHashes`** additionally let a consumer spot-check individual blocks.
  The **embedded erasure-certificate JWS strings are covered by the bundle signature** (a swap/tamper
  of a nested cert breaks bundle verification — a test pins this) **and** keep their own signature so
  each remains independently verifiable via `verifyErasureCertificate`. (std-owasp #8; CWE-345/347.)
- **S / R (spoofing / repudiation):** **alg-pinned EdDSA** (rejects `alg:none`/`HS*`/any non-EdDSA —
  CWE-347) against the operator's **published public JWK**, with a distinct protected-header `kid`
  (`tenantforge-evidence-bundle`) + `typ` (`application/evidence-bundle+jws`). A confused deputy cannot
  cross types: a **compliance-report JWS or erasure-cert JWS does not verify as a bundle**, and a
  **bundle JWS does not verify as a report or cert** (pinned by cross-type abuse tests in both
  directions). Signing emits a `compliance.evidence_bundle_signed` audit event (non-repudiation).
- **I (information disclosure) — the per-tenant BOLA boundary:** the bundle carries **attestation
  facts only** (counts, isolation/residency booleans + offending ids, a redacted audit excerpt, and
  the already-signed erasure-cert JWS strings) — **no secrets, no connection URIs** (master §5; a
  canonicalization test asserts the signed claims never match secret/connection patterns). For a
  **per-tenant** bundle, the **server-derived** `tenantId` scopes **every** artifact (inventory,
  attestations, audit excerpt filtered to that tenant, only that tenant's certs) — a tenant's bundle
  can **never** carry another tenant's facts (pinned by a cross-tenant scoping test). `buildEvidenceBundle`
  **fails closed** on an ambiguous scope (tenant scope without an id, fleet scope with one, or an
  unknown scoped tenant), and the verifier enforces the scope ↔ `tenantId` invariant. **Access control
  on the _retrieval_ of a bundle is Phase 3** (operator-only, then no-cross-tenant fetch — BOLA on
  fetch); the _content_ is scoped here regardless, so a leaked tenant bundle exposes only that tenant.
- **D (denial of service):** assembly is a bounded registry read + a bounded audit query (the same
  caps the compliance report uses); signing is one EdDSA operation. No new unbounded surface.
- **E (elevation):** no privilege boundary is crossed by signing; the signer holds only its own
  private key. The signing key is **private**, from config/secret-manager, never logged — and the
  bundle **reuses the compliance evidence key** (`TENANTFORGE_COMPLIANCE_SIGNING_KEY`; no third key),
  distinguished only by `typ`/`kid`. Only the **public** JWK is exposed (`evidenceBundlePublicKey()`).
- **Always-signed / fail-closed:** `evidenceBundle()` **fails closed** without a signer (no unsigned
  bundle). Production **requires** the compliance key (validated at startup via
  `buildEvidenceBundleSigner`, a defense-in-depth re-check independent of `loadConfig`); non-prod with
  no key uses an ephemeral key (warned; not verifiable across restarts).
- **Verification is the product (HARD REQUIREMENT):** an auditor verifies a bundle **offline with only
  the public key** — `verifyEvidenceBundle(jws, jwk)` is **pure, deterministic, alg-pinned, and
  fail-closed** (mirrors `verifyComplianceReport`/`verifyErasureCertificate`), allow-list-validating
  every block with no coercion. Embedded certs are verified separately by the consumer.

#### B10a — Evidence at rest (persistence) — Phase 3a SHIPPED (2026-06-25)

The `EvidenceStore` persists the signed bundle at rest with a queryable `EvidenceManifest` index.
Evidence-at-rest STRIDE addendum (the **retrieval-authz** STRIDE — who may _fetch_ — is **Phase 3b**):

- **I (information disclosure) — confidential at rest + non-guessable keys:** the bundle body is a
  **confidential** artifact (tenant ids, residency, an audit excerpt) but carries **no secrets, no
  connection URIs** (master §5). The storage key (`bundleId`) is **128 bits of CSPRNG entropy** —
  **non-guessable, never sequential** — so a stored bundle can't be enumerated (the **F7/L3 lesson**),
  and the object key is tenant-scoped (`{prefix}/{tenant|fleet}/{bundleId}.jws.json`). **Encryption at
  rest is the underlying object store's concern** (S3/GCS SSE / KMS-backed bucket / encrypted volume —
  least-privilege bucket access), consistent with the off-Neon archive tier. The **`EvidenceManifest`
  index carries facts only** (`bundleId`/`scope`/`tenantId`/`generatedAt`/`storedAt`/`signerKid`/
  `contentHashes`/`retentionUntil`) — **no JWS body, no secrets** (a test asserts the manifest JSON
  never contains the JWS).
- **I — store-level tenant scoping (BOLA groundwork):** `get(bundleId, tenantScope)` returns a bundle
  **only** when the scope matches — a tenant-scoped fetch never returns another tenant's (or a fleet)
  bundle (pinned by a tenant-scope-isolation test). **The access-control decision (which scope a caller
  gets) is enforced at the Phase 3b surface, NOT the store**; the store only enforces the scope it is
  told (complete mediation / defense in depth so 3b can't accidentally bypass ownership).
- **T (tampering) / R (repudiation):** the persisted body is the **signed** bundle — tamper at rest is
  detected by `verifyEvidenceBundle` (the signature is unchanged by persistence). Persisting emits a
  `compliance.evidence_bundle_persisted` audit event (non-repudiation: who/when a bundle was stored).
- **C (confidentiality) / privacy — retention & deletion:** each manifest gets a `retentionUntil`
  (`TENANTFORGE_EVIDENCE_RETENTION_DAYS`, `0` ⇒ indefinite — the conservative default for durable
  auditor evidence); `evidencePrune` is the **idempotent, batched** retention sweep
  (`@rules/workflow-data-lifecycle.md`). Object-store body deletion is the store's own lifecycle policy
  (the write-only port exposes no delete — archive-tier precedent).
- **Fail-closed persistence:** with no store wired, generation still succeeds but **does not claim
  persistence** (manifest omitted — explicit, never silent); with a store, a **persist failure fails
  the call** (an auditor must not believe a bundle is durably stored when it is not — master §2).
- **D (denial of service):** `put` is one bounded write + index insert; `list`/`pruneExpired` are
  **bounded** (limit clamped — no unbounded scan). No new unbounded surface.

### B11 — Evidence retrieval surface (the fetch boundary) — Phase 3b SHIPPED (2026-06-25)

> **Status: Phase 3b of the compliance evidence layer landed (ADR-0011).** The **access-controlled
> retrieval surface** for persisted, signed evidence bundles: operator-gated HTTP reads
> (`GET /v1/evidence/bundles`, `GET /v1/evidence/bundles/:bundleId`), a public-key endpoint
> (`GET /v1/evidence/public-key`), operator CLI (`evidence-list`, `evidence-get`), and a **read-only**
> MCP surface (`tf_evidence_list`, `tf_evidence_public_key`). A **durable pg-backed `EvidenceStore`**
> (`TENANTFORGE_EVIDENCE_STORE=pg`, migration 0013 `tf_evidence_bundles`) closes the 3a in-process-index
> gap so `get`/`list`/`pruneExpired` survive restart and hold across replicas. **Scope is
> OPERATOR-ONLY** (ADR-0011 locked decision #5): the consumers are authenticated operators. **Tenant
> self-serve retrieval via the portal stays DEFERRED** (no portal/tenant-facing fetch path here). The
> **dashboard evidence panel (Phase 3c) has since SHIPPED** — the operator-gated, `evidence:read`
> dashboard routes (`GET /dashboard/api/evidence/bundles`, `.../:bundleId`, `.../public-key`) reuse
> exactly this fetch boundary's authz and scoping (server-derived fleet scope, no client-supplied
> tenant id — `src/app/dashboard.ts`); it adds a human-facing window onto the same surface, not a new
> trust boundary. This is the **fetch boundary** the Phase 2
> content-scoping + Phase 3a key/index were groundwork for. STRIDE on it:

- **S (spoofing) / AuthN:** every retrieval route/command/tool — **except the public-key endpoint** —
  requires an authenticated principal. HTTP reuses the existing `authenticate` middleware (bearer
  token / OIDC JWT via the `Authenticator` port); an unauthenticated request → **401** (pinned by a
  negative test). The MCP surface runs as the single attributed `mcp` operator (ADR-0004), so it is
  authenticated by construction. The public-key endpoint is intentionally **unauthenticated** — it
  serves a **public** key.
- **E (elevation) / AuthZ — deny-by-default, OPERATOR role required (the crux):** retrieval is gated
  on a **new dedicated permission `evidence:read`**, held by `admin` + `operator` but **NOT** by
  `readonly` (so it is genuinely operator-gated, not merely "any authenticated reader" — a `readonly`
  token → **403**, pinned by a negative test). Evaluated **server-side** on every route/command/tool
  (`requirePermission('evidence:read')` — std-owasp-api API5 Broken Function Level Authorization,
  topic-authn-authz, deny by default). The public-key endpoint requires **no** permission (public
  key). No privilege boundary is crossed by a read; the surface exposes only the **public** JWK and
  already-signed, no-secret evidence.
- **I (information disclosure) — confidential evidence + the BOLA note:** an evidence bundle body is a
  **confidential** artifact (tenant ids, residency, a redacted audit excerpt) but carries **no secrets,
  no connection URIs** (master §5; the Phase 2 canonicalization test pins this). It is served **only to
  authenticated operators** over TLS. **BOLA (the project's #1 risk):** the tenant scope passed to the
  store is **server-derived, never client-supplied** — for the operator surface it is the **fleet scope
  (`null`)**, so an operator can fetch any bundle (their legitimate fleet-wide remit), but the path
  `bundleId` is **never** interpreted as a tenant selector and there is **no client-supplied tenant-id
  parameter** anywhere on the surface. The store's `get(bundleId, tenantScope)` second argument is set
  by the server, not the request. This is the **groundwork for the deferred tenant-self-serve path**:
  when it lands, it will pass the **server-derived tenant id** (from the authenticated tenant
  principal) as `tenantScope`, and the store already refuses to return another tenant's (or a fleet)
  bundle under a tenant scope (the store-level half of BOLA defense, B10a). A cross-tenant abuse test
  asserts a tenant-scoped fetch of another tenant's bundle returns nothing. The **public-key endpoint
  exposes ONLY the public JWK** — a serialization guard + a test assert it never contains the private
  `d` parameter (CWE-200; no private key material ever leaves the process).
- **R (repudiation) — audit every authenticated access:** every operator retrieval (`list`/`get`)
  emits a redacted audit event via the existing `observe`/event sink — `compliance.evidence_list`,
  `compliance.evidence_fetch` — recording the **operator id** (from the actor context), the
  **bundleId** (a non-secret handle) where applicable, and the **outcome** (`ok`, with a `found:
true|false` flag on a fetch; `error` reserved for failures). **Facts only — never the bundle body,
  never the JWS, never a key** (master §5). A fetch of an unknown/out-of-scope id audits `found:
false` (the **404** also never reveals whether the id exists out of scope — uniform "Not Found").
  The **public-key endpoint is deliberately NOT audited**: it is unauthenticated (no principal to
  attribute) and exposes only the public JWK — there is no confidentiality or repudiation concern to
  record (auditing an anonymous public read would be noise without evidentiary value).
- **D (denial of service) — bounded/paginated list:** `GET /v1/evidence/bundles` is **bounded** — the
  `?limit` is parsed, validated (positive integer → 400 otherwise), and the store **clamps** it to
  `[1, MAX_LIMIT=1000]` (no unbounded result set; the same DoS control as the tenant list and the 3a
  store). Per-principal rate limiting + the body-size cap from the existing `/v1/*` middleware apply.
  `get` is one bounded lookup. (A pagination-bound test asserts a huge `?limit` is clamped.)
- **T (tampering):** the served body is the **signed** bundle; an auditor verifies it **offline with
  only the public key** (`verifyEvidenceBundle` against `GET /v1/evidence/public-key` / the
  `evidence-get --verify` CLI). Tamper in transit or at rest is detected by the signature — the
  retrieval surface adds no new trust in the channel (verification is the product).
- **Durable index (closes the B10a 3a gap):** the **pg `EvidenceStore`** (`tf_evidence_bundles`,
  migration 0013) persists the manifest **and** the no-secret signed body as `jsonb`, indexed on
  `(scope)`, `(tenant_id)`, `(stored_at)`, `(retention_until)`, so `get`/`list`/`pruneExpired` are
  durable + cross-replica (mirrors the pg pending-erasure adapter). The body column holds **only** the
  signed bundle (attestation facts + JWS) — **no secrets/connection URIs**; the table is in the
  metadata control-plane DB (not tenant content). TLS-enforced at construction (`assertPostgresTls`),
  fail-closed (the documented `allowInsecure` local-dev opt-out). The in-memory + object-store adapters
  remain for dev/test and the object-body-at-rest tier.
- **Out of scope here:** **tenant self-serve retrieval** via the portal is what _this_ B8e section now
  covers (it shipped — see the heading). The **operator dashboard evidence panel (Phase 3c) has also
  shipped** (`src/app/dashboard.ts`, B11) — an operator-facing window on the B11 fetch boundary, not a
  tenant-facing one; it is a separate surface from this tenant self-serve path.

### B8e — Tenant self-serve evidence retrieval (the portal fetch boundary) — Phase 3d SHIPPED (2026-06-25)

> **Status: the deferred customer-facing half of the evidence layer landed (ADR-0011 decision #5 →
> portal read path now built; ADR-0010 governs the portal surface).** This is the **highest-BOLA-risk
> slice in the evidence layer** — a _customer_ fetching per-tenant **confidential** evidence over the
> self-serve portal. It implements what B11's "groundwork for the deferred tenant-self-serve path"
> prescribed: the portal passes the **server-derived tenant id** (from the authenticated portal
> session) as the store `tenantScope`, **never `null`/fleet, never a client parameter**. Reuses the
> **portal session / `TenantAuthenticator`** (B8/B8w) — **not** the operator RBAC `evidence:read` (B11).
> New surface: `GET /portal/api/evidence` (list **my** manifests), `GET /portal/api/evidence/:bundleId`
> (download a specific **own** signed bundle), `GET /portal/api/evidence/public-key` (the public JWK),
> and `POST /portal/api/evidence/generate` (self-generate the tenant's **own** current bundle —
> non-destructive). A self-serve "Download my compliance evidence" view in the portal SPA
> (`portal/`). Behind a benign **default-OFF rollout flag** `TENANTFORGE_PORTAL_SELFSERVE_EVIDENCE`
> (`PortalOptions.enableEvidence`) for staged rollout — **separate from**
> `TENANTFORGE_PORTAL_SELFSERVE_DESTRUCTIVE`, which gates ONLY cancel/erasure (this read/self-generate
> path is non-destructive and must not entangle with it). STRIDE on the tenant evidence-fetch path:

- **E (EoP / BOLA — THE headline threat, the project's #1 risk):** the tenant id is taken **ONLY from
  the authenticated portal session** (`sessionOf(c).tenantId`), **never** from request input — no
  route accepts a `tenantId` param, and `:bundleId` is a **non-guessable handle, never a tenant
  selector**. Every store call passes the **session tenant id** as `tenantScope`:
  `evidenceList({ tenantId })` / `evidenceGet(bundleId, tenantId)` / `evidenceBundle({ scope:'tenant',
tenantId })`. A tenant can therefore `list`/`get`/`generate`/download **only its own** bundles. The
  store's `get(bundleId, tenantScope)` (B10a) refuses to return another tenant's (or a **fleet**)
  bundle under a tenant scope — so even a leaked/guessed `bundleId` for tenant B, requested by tenant
  A, returns **nothing** → a **uniform 404** (`Not Found`, no body) with **no existence oracle** (the
  404 is byte-identical whether the id is unknown, pruned, fleet-scoped, or another tenant's). `list`
  is server-filtered to the session tenant, so it can never enumerate another tenant's manifests. This
  is **complete mediation + defense in depth**: the surface scopes (B8e) **and** the store re-checks
  (B10a) **and** the bundle _content_ is already per-tenant-scoped (B10/Phase 2) — three independent
  layers. **Pinned by the mandatory cross-tenant abuse test** (tenant A's session requesting tenant
  B's `bundleId` → 404; A's `list` returns only A's manifests even when B's ids are tried).
- **S (spoofing) / AuthN:** the surface is behind the existing portal **session** (signed, HttpOnly,
  `SameSite=Strict` cookie minted from the `TenantAuthenticator` / OIDC code flow — B8/B8w). An
  unauthenticated or invalid/expired/tampered session → **401** (fail closed; pinned by a negative
  test), **except** the public-key endpoint which is intentionally **unauthenticated** (it serves a
  **public** key). No `evidence:read` operator permission is involved — this is a distinct,
  self-scoped customer surface (ADR-0010), never the operator/fleet plane.
- **I (information disclosure):** an evidence bundle body is **confidential** (the tenant's own ids,
  residency, a redacted audit excerpt) but carries **no secrets, no connection URIs** (master §5; the
  Phase 2 canonicalization test pins this) — and a tenant bundle holds **only that tenant's** facts
  (B10 content-scoping), so the customer sees only their own confidential evidence, served over TLS.
  The **public-key endpoint exposes ONLY the public JWK** (`{kty,crv,x,kid,alg,use}` — never the
  private `d`; the facade returns the public key and a test pins no-`d`). The manifest list is
  **facts only** (no JWS body). Served fields are projected — no infra ids, no `billingCustomerRef`
  (the bundle never carried them).
- **R (repudiation) — audit every tenant fetch with the tenant principal:** `list`/`get`/`generate`
  go through the facade (`evidenceList`/`evidenceGet`/`evidenceBundle`), which emit redacted
  `compliance.evidence_list` / `compliance.evidence_fetch` / `compliance.evidence_bundle_signed` +
  `…_persisted` events. Because the portal runs the facade call **within the tenant actor context**
  (the session tenant as principal), the events are attributed to the **tenant**, not an operator —
  facts only (`bundleId` handle, count, `found:true|false`), never the body/JWS/key. The public-key
  read is **not** audited (unauthenticated, public material — no repudiation concern, consistent with
  B11).
- **T (tampering):** the served body is the **signed** bundle; the customer (or their auditor)
  verifies it **offline with only the public key** (`verifyEvidenceBundle` against
  `GET /portal/api/evidence/public-key`). Tamper in transit/at rest is signature-detected — the
  retrieval surface adds no new channel trust (verification is the product).
- **D (denial of service):** `list` is **bounded** — the store clamps `?limit` to `[1, 1000]`; the
  portal also caps it and rejects a non-positive integer (400). `get` is one bounded lookup.
  **Self-generate** is the only non-trivial op: it is **per-session/per-IP rate-limited** (a tight cap
  via the existing portal limiter — bounded registry read + one EdDSA sign + one store write), behind
  CSRF (it is a `POST`/state-changing-at-the-store request → a signed per-session token in
  `X-TF-CSRF` + `Origin`/`Sec-Fetch-Site` allow-list, like every other portal mutation). The 8 KB
  body cap applies. No unbounded surface.
- **Generate-on-demand (DECISION — enabled, non-destructive):** the portal **may self-generate** the
  tenant's **own** current evidence bundle (`evidenceBundle({ scope:'tenant', tenantId:<session> })`)
  in addition to downloading already-persisted ones — read-only assembly + sign, scoped to the
  session tenant, persisted so it appears in the tenant's own list. **Rationale:** the feature is
  useful even when operators haven't pre-persisted per-tenant bundles (B11's deferred note assumed
  operator pre-generation); it is **structurally incapable of affecting another tenant** (server-
  derived scope, like every other portal action). It is **non-destructive**, so it is **NOT** gated by
  `TENANTFORGE_PORTAL_SELFSERVE_DESTRUCTIVE` (that flag gates only the cancel/erasure destructive
  pair); it sits behind its own benign rollout flag. The flag is OFF by default purely for **staged
  rollout** of a new customer-facing surface, not because the path is risky.
- **Fail-closed / fail-soft:** with no evidence store wired, `list` returns `[]` and `get` returns
  `null` → the SPA shows an empty/"no evidence yet" state (never a 500). With no signer wired,
  `generate` fails closed (the facade throws "no evidence-bundle signer configured" → a safe 503-class
  error) and the public-key endpoint returns 404 — the SPA degrades gracefully (the generate button
  reports it's unavailable). An unknown/out-of-scope/pruned `bundleId` → uniform 404.

### B12 — Public internet → self-serve signup/onboarding — SHIPPED (Phase 3)

> **The largest UNAUTHENTICATED, abuse-prone surface.** The public self-serve signup flow
> (`src/app/signup.ts`) lets an anonymous stranger create a TenantForge account, prove an email,
> attach a payment method, and **provision a real Neon project** (a cost-incurring resource). Unlike
> B1/B8/B8w there is **no principal yet** — identity is _being established_ across the flow — so the
> controls are the unauthenticated kind: a captcha gate, per-IP rate limits, a short-lived signed
> session cookie carrying an opaque signup id, email-code proof-of-control, and a server-verified
> Stripe SetupIntent. Card data never touches our server. This is **OWASP API6 (unrestricted access
> to a sensitive business flow)** territory — the threats below are mass-provisioning/cost-abuse and
> automation, not BOLA.

- **S (spoofing) / T (tampering) — email verification:** proof-of-control is a **6-digit one-time
  code**, sent to the claimed address; only its **SHA-256 hash** is persisted (never the plaintext —
  master §5), with a TTL (`TENANTFORGE_EMAIL_CODE_TTL_MS`, default 15 min — `src/app/config.ts`). The
  code is generated with `randomInt` (CSPRNG, not `Math.random`) and compared **constant-time**
  (`timingSafeEqual`) so a wrong guess leaks no timing signal (`startSignup`/`verifyEmail`,
  `src/app/lib.ts`). Brute force is **bounded**: `assertVerifiable` fails closed once the record is
  expired/`verified`/`locked`, and `recordFailedAttempt` locks the record at `MAX_ATTEMPTS = 5`
  (`src/core/email-verification.ts`) — a 6-digit space (10⁶) with ≤5 attempts before lock-out plus the
  per-IP `verify` cap (10/min) makes guessing infeasible. The signup-step cookie is a signed
  (HMAC-SHA256, base64url) **HttpOnly, `Secure`, `SameSite=Strict`**, path-scoped, expiring token whose
  body is verified constant-time and **fails closed** on any tamper/expiry (`decodeSession` returns
  `null` → 401) — the opaque signup id is server-minted, never client-named.
- **D (denial of service) / abuse:** the **captcha is verified BEFORE any cost-incurring work**
  (email send / PSP call) and **fails closed** — a Turnstile outage, timeout, non-2xx, or unparseable
  body yields `{ success: false }`, never an open gate (`src/adapters/captcha/turnstile-verifier.ts`).
  Every endpoint is **per-IP fixed-window rate-limited** (`limited(...)` keyed on the XFF first hop):
  `start` 5/min, `verify` 10/min, `payment` 5/min (tighter — it opens a Stripe call), `complete`
  10/min, `status` 60/min — over-limit → **429 + `Retry-After`**. All `/api/*` bodies are hard-capped
  at **8 KB** (`bodyLimit`) and every payload is `zod`-validated (bounded string lengths, `email()`,
  enum `residency`). The limiter store is pluggable (`RateLimitStore`); a `pg` backend makes the cap
  **global across replicas** (R2) — the in-memory default is per-instance.
- **T / I (disclosure) — payment setup:** card capture is **Stripe Elements + a SetupIntent** — the
  PAN never reaches our server (PCI scope reduction). The server **never trusts a client "success"**:
  at `complete` it re-fetches the SetupIntent and requires `status === 'succeeded'` with a saved
  payment method, **and** checks `intent.customerRef === req.customerRef` so a SetupIntent for
  customer X cannot be bound to signup Y (PSP-side BOLA — mirrors B8w/F5). A PSP setup intent is
  **never opened until the email is proven** (`status` must be `email_verified`/`payment_ready`) — a
  card-testing guard. Only the **public** Stripe publishable + captcha site keys are exposed
  (`GET /api/config`); the secret keys stay server-side.
- **API6 — automated abuse of the business flow (mass provisioning + slug squatting):**
  - _Cost inflation / mass provisioning:_ provisioning a Neon project costs money, so the flow is
    gated by **captcha + email-proof + a verified payment method** before `completeSignup` enqueues a
    provision — an attacker must pass a human-ish challenge, control a real inbox, **and** attach a
    chargeable card per account, which (with the per-IP rate limits) makes bulk fake-tenant creation
    expensive and slow. The provision itself is **enqueued** (idempotent consumer, B6), not run inline.
  - _Slug squatting / enumeration:_ `complete` rejects an already-taken slug, but the error is a
    **generic `slug unavailable` (409)** that **never reveals whether the slug belongs to another
    tenant** (`completeSignup` → `registry.getBySlug`, `statusFor` maps it to 409) — no
    existence-oracle for enumeration. Slug is length-bounded + `assertSlug`-validated.
- **R (repudiation):** each step emits a tenant/flow-scoped audit event (`signup.started`,
  `signup.email_verified`, `signup.payment_setup`, …) carrying the **opaque signup id only — never
  the email or code** (PII/secret redaction, master §5).
- **Residual / decisions:** per-IP keying trusts the **`X-Forwarded-For` first hop**, so it assumes a
  trusted edge proxy sets/strips XFF — behind a misconfigured or absent proxy a client could spoof the
  key and dodge the per-IP cap (the captcha + email-proof + payment gate remain). **Accepted Low**,
  owned by the maintainers: deploy behind a trusted edge that normalizes XFF; promote the limiter to
  the `pg` store for cross-replica enforcement. Captcha **quality** (Turnstile difficulty) is a tuning
  knob, not a hard guarantee — defense-in-depth, layered with the other gates, not relied on alone.

## Residual risks (tracked)

- **R1 — closed.** Per-operator credentials + RBAC are in-app (admin/readonly, constant-time compare),
  and authentication is now pluggable behind the `Authenticator` port: in addition to static tokens,
  an **OIDC mode** (`TENANTFORGE_AUTH_MODE=oidc`) verifies a Bearer JWT against an external issuer's
  JWKS (`jose`; signature + `iss`/`aud`/`exp`, asymmetric-alg allow-list) — phishing-resistant,
  externally-managed identity with no shared secrets. Static tokens remain the default for simple deploys.
- **R2 — closed.** A 1 MB body cap **and** a per-principal rate limit are enforced in-app, behind a
  `RateLimitStore` port: the default is in-memory (per-instance); a **Postgres-backed** store
  (`tf_rate_limits`, migration 0004, `TENANTFORGE_RATE_LIMIT_STORE=pg`) makes the limit **global
  across instances** for multi-replica deployments — no extra deps.
- **R3 — addressed (Low residual).** A load/soak harness (`pnpm load`) drives the fleet fan-out over
  a large synthetic fleet, and a CI test guards that concurrency stays within the batch bound (no
  unbounded fan-out → no rate-limit/connection blowout). Remaining: the **live-Neon load profile**
  (pacing provisioning + fleet migration into Neon's real `429` limits) is operator-run against a
  non-prod org — documented in `docs/runbooks/scaling.md`.
- **R4 — closed.** The live-Neon game-day passed locally **and in CI** (10/10), the **`NEON_API_KEY`
  rotation** was drilled (suite re-run on the rotated key), and the **Neon PITR restore** was drilled
  with a row-level recovery proof (2026-06-18) — all against a non-prod org. See
  `docs/runbooks/drill-report.md`.

All four gating risks (R1–R4) are addressed/drilled — the basis for the **`beta → stable`
promotion (v0.3.0)**; R1 and R2 are now fully **closed** (OIDC auth + cross-instance rate limiting).
The remaining items above are accepted **Low residuals**, owned by the maintainers and time-boxed at
the next review (not promotion blockers).

## Abuse cases → tests

Each boundary's key threat is pinned by a negative/abuse test (master §4, `@rules/topic-multi-tenancy.md`):

| Threat                                    | Test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BOLA / cross-tenant bleed (B3/B4)         | `getConnection(A)` returns A's project/URI, never B's (two tenants)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Fail-closed routing (B3)                  | every non-`active` status is non-routable; active-but-no-secret fails closed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Illegal lifecycle transition (B3)         | exhaustive transition matrix — every disallowed `(from,to)` rejected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Excessive agency (B2)                     | the MCP tool set exposes **no** `purge`/`purge-expired`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Spoofing (B1)                             | HTTP returns 401 on a missing/incorrect bearer token                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Broken function authZ (B1, API5)          | a `readonly` operator gets 403 on a mutating route; `admin` may mutate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| DoS / rate limit (B1)                     | over-limit requests get 429 + `Retry-After`; the window refills                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Untrusted payload (B6)                    | invalid queue payload is dead-lettered, never handled                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Residency (B7)                            | provisioning fails closed outside the region allow-list / required jurisdiction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Secret disclosure (B7)                    | connection URI never appears in events/registry records                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Cross-tenant portal read (B8)             | `tenant{Charges,Refunds}(A)` never return B's; portal reads no tenant id from the request; `tenantSummary` omits metadata/secrets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Cross-tenant portal **mutation** (B8w)    | a session for A cannot change B's plan / payment method / cancel / erase B; no route accepts a `tenantId` (`portal-selfserve.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| CSRF on mutations (B8w)                   | a state-changing POST without a valid signed CSRF token, with another tenant's token, or cross-site is rejected (`portal-selfserve.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Step-up bypass (B8w)                      | cancel / erasure without a verifying control-plane second factor is rejected; a code is single-use + action-bound (`portal-selfserve*.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Idempotency replay (B8w)                  | a duplicate plan-change with the same `Idempotency-Key` applies **once** (replays the response) (`portal-selfserve.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Erasure undo window (B8w)                 | cancel before the window → project intact; after → erased + certificate; a cancel-vs-execute race can't double-delete; redelivery is idempotent (`portal-selfserve-facade.test.ts`, `pending-erasure-store.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Unverified / cross-customer payment (B8w) | a client's "card saved" without a server-verified SetupIntent is rejected, and a SetupIntent whose `customerRef` ≠ the tenant's is rejected (F5) (`portal-selfserve*.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Cancel billing exclusion (B8w)            | a cancelled (`offboarding`) tenant is absent from the active set the billing/dunning sweeps charge (`portal-selfserve-facade.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Signed erasure certificate (B8w)          | sign→verify round-trips; a **tampered** cert, the **wrong public key**, and **alg-confusion** (`alg:none`/`HS*`/non-EdDSA) all fail closed; always-signed engine; prod startup fail-fast without a key; post-erasure signing failure fails soft (no rollback) (`erasure-cert.test.ts`, `certificate-signer.test.ts`, `erasure-engine.test.ts`, `config-erasure-signing.test.ts`)                                                                                                                                                                                                                                                                   |
| Signed compliance report (B9)             | sign→verify round-trips; a **tampered** report, the **wrong public key**, **alg-confusion** (`alg:none`/`HS*`/non-EdDSA), wrong **typ**, and a real **erasure-cert JWS** (cross-type confusion) all fail closed; the signed claims carry no secrets/connection URIs and equal the digested canonical JSON (`compliance-cert.test.ts`)                                                                                                                                                                                                                                                                                                              |
| Evidence bundle (B10)                     | fleet + per-tenant sign→verify round-trips; **per-tenant scoping** (tenant A's bundle holds only A's artifacts; no cross-tenant id leaks); embedded erasure cert still **verifies independently** and a **tampered embedded cert** breaks bundle verification; **cross-type** both ways (a report/erasure JWS fails the bundle verifier; a bundle JWS fails the report/erasure verifier); the full abuse battery (tamper, wrong key, `alg:none`/`HS256`, wrong `typ`, every malformed-shape + scope-invariant branch) fails closed; no secrets/connection URIs in the signed claims (`evidence-bundle.test.ts`)                                    |
| Self-serve signup abuse (B12, API6)       | email-code brute force locks at `MAX_ATTEMPTS` (constant-time compare, hashed code, TTL); a failed/outage captcha fails closed (no open gate); over-limit signup steps get 429 + `Retry-After`; an unverified-email payment-setup is rejected; a SetupIntent whose `customerRef` ≠ the signup's is rejected; an existing slug returns a generic 409 (no enumeration oracle) (`signup*.test.ts`, `turnstile-verifier.test.ts`, `email-verification.test.ts`)                                                                                                                                                                                        |
| Evidence at rest (B10a, Phase 3a)         | put→get round-trip; **tenant-scope isolation** (a tenant fetch never returns another tenant's or a fleet bundle; operator/`null` may fetch either); **non-guessable ids** (128-bit, 32-hex, non-sequential, unique); `pruneExpired` removes **only** expired bundles (indefinite ones survive) and is idempotent; the manifest carries **no JWS body / no secrets**; persist-on-generate returns the manifest with a store and **omits it without one** (no silent persistence); the persist **webhook payload is manifest facts only** (no body/secrets) (`evidence-manifest.test.ts`, `evidence-store.test.ts`, `evidence-store-facade.test.ts`) |

---

_Last reviewed: 2026-06-30 (B12 added — the public self-serve signup/onboarding flow (`src/app/signup.ts`): captcha + per-IP rate limits + email-code proof + server-verified Stripe SetupIntent; OWASP API6 mass-provisioning/cost-abuse + slug-squatting controls. Corrected B11/B8e: the operator dashboard evidence panel (Phase 3c) has SHIPPED. Prior: 2026-06-25 ADR-0011 Phase 3a — evidence-at-rest persistence (B10a); Phase 2 — evidence bundle assembly + sign + verify (B10)). Owner: TenantForge maintainers. Review on any trust-boundary change._
