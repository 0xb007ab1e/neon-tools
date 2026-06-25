# ADR 0010 — Self-scoped customer-portal write surface (amends ADR-0004)

- **Status:** Accepted (2026-06-24) — Phase 1 backend implemented (`feat/portal-selfserve`); the destructive pair (cancel + erasure) is flag-gated OFF pending security review
- **Amends:** [ADR-0004](0004-secret-and-money-ops-off-the-agent-surface.md)

## Context

ADR-0004 gates money-/secret-/lifecycle-bearing operations **off** the MCP and dashboard surfaces,
keeping them on the authenticated CLI/HTTP plane. That ADR addressed the **operator** dashboard and
the **agent** (MCP) surface; the **customer self-serve portal** (`src/app/portal.ts`) was, and is,
**read-only** (threat-model B8). But a customer-facing SaaS needs self-serve account management —
update a card, change plan, see invoices, cancel, export/erase their data — without an operator in
the loop. The plan is `docs/research/portal-spa-plan.md`; the threat model is **B8w**.

The key question ADR-0004 raises: does letting a customer perform money/lifecycle actions reintroduce
the risks 0004 closed? The answer turns on **scope**. The portal already derives the tenant id
**only** from the signed session, never from request input (no route accepts a `tenantId`), and
tenant isolation is **physical** (one Neon project per tenant — ADR-0001). So a portal mutation is
structurally incapable of affecting another tenant. The relaxation is therefore narrow: a customer
acting on **its own account only**.

A design red-team (2026-06-24) upheld this core but required hardening on the two destructive paths;
its rulings are folded into the decision below.

## Decision

**Amend ADR-0004:** the customer portal becomes a **write surface for the authenticated tenant's own
account only** — distinct from the operator dashboard (still read-only per 0004) and the agent/MCP
surface (still excluded per 0004). Permitted self-serve actions: **update payment method, change
plan, view invoices/billing, cancel (offboard), data-export, and erasure** — each gated by blast
radius:

- **Tenant id is always session-derived, never client-supplied** (the BOLA invariant ADR-0004's
  spirit depends on). Money/lifecycle are permitted **but self-scoped**.
- **Money ops** (payment-method, plan change): CSRF (signed token in a custom header) + rate-limit +
  **endpoint-level idempotency** + server-side SetupIntent verification incl.
  `intent.customerRef === tenant.billingCustomerRef`. Card data via Stripe Elements (PAN off-server).
- **Cancel** = `offboard` (project retained, reversible) — **never** `purge`.
- **Erasure** (irreversible): typed confirmation **+ a control-plane-owned second factor**
  (single-use email/TOTP code — _not_ IdP `auth_time`) **+ a mandatory undo window** during which the
  tenant **keeps serving** and may cancel; execution is a single atomic conditional flip
  (no cancel/executor race), idempotent across redelivery; emits the **cryptographically signed
  erasure certificate** (see below) and alerts operator + the tenant's verified email.
- **Rollout:** cancel + erasure ship behind a **feature flag, off** until their abuse tests are green
  and security-reviewed (deploy decoupled from release); the other actions go live first.

The agent/MCP and operator-dashboard gates of ADR-0004 are **unchanged** — this carve-out is the
customer portal only.

## Alternatives considered

- **Keep the portal read-only; operators fulfil all account changes** — rejected by the owner: not a
  viable self-serve SaaS; pushes routine work to operators.
- **Operator-request model** (customer requests, operator approves/executes cancel + erasure) —
  rejected (owner decision #1): customers get true self-serve, with strong gating instead of a human
  approver.
- **IdP `auth_time` recency for step-up** — rejected (red-team F1): an IdP can mint a fresh token via
  silent refresh/`prompt=none` with no human present; a control-plane second factor is used instead.
- **Suspend the tenant while erasure is pending** — rejected (red-team F2): creates a timer-delayed
  self-serve DoS; the tenant keeps serving until the executor runs.

## Consequences

- The portal can move money and run lifecycle actions, but **only for the calling tenant** — the
  cross-tenant/agent risks ADR-0004 closed remain closed (different surface, self-scoped, tested).
- New machinery: a one-time-code (second-factor) store, a pending-erasure state + atomic cancellable
  executor, endpoint-level idempotency wiring, portal CSRF, and self-serve-destructive alerting.
- Each new portal action must classify its blast radius and gating up front (as ADR-0004 requires for
  every feature). Cross-tenant **mutation** attempts join the abuse-test suite (threat-model B8w).
- Revisit if the portal ever needs to act beyond the calling tenant (it must not) or if a customer
  action gains operator-level blast radius (it must not).
- **Durability/multi-replica prerequisite now satisfiable.** With `TENANTFORGE_PENDING_ERASURE_STORE=pg`
  (migration 0012, `tf_pending_erasures`) each undo-window cancel/claim flip is a single SQL conditional
  `UPDATE … WHERE status='pending'` whose rowcount decides the winner, so the at-most-once invariant
  holds **across replicas and survives restarts** (not only within one single-threaded process, as the
  in-memory adapter did). This removes the operational blocker on flipping
  `TENANTFORGE_PORTAL_SELFSERVE_DESTRUCTIVE` in a multi-replica/restart-sensitive deployment — the flag
  itself remains a separate, default-OFF go/no-go decision, and CI must exercise the integration suite
  (a skipped suite counts as failure) for the cross-replica guarantee to be relied upon.

## Signed erasure certificate (implemented 2026-06)

The erasure certificate is now **cryptographically signed and independently verifiable**, not just an
attestation object. Mechanism:

- **Format:** a **compact JWS over the certificate claims, signed with EdDSA (Ed25519)** via `jose`
  (mirrors the OIDC authenticator's vetted-library, alg-allow-list conventions — no hand-rolled
  crypto, master §1 / `topic-cryptography`). The protected header pins `alg: EdDSA` + a domain `typ`
  (`application/erasure-cert+jws`). Verification (`verifyErasureCertificate`) **pins EdDSA** and
  rejects `alg:none`/`HS*`/any non-EdDSA (no alg-confusion — CWE-347/std-cwe), checks the `typ`, and
  re-hydrates the claims with allow-list validation (fail closed on any tamper/forgery).
- **Always-signed (no unsigned fallback).** There is one path: a `CertificateSigner` port is injected
  into the erasure engine. The signing key is **validated at startup (fail-fast)**; production
  **requires** `TENANTFORGE_ERASURE_SIGNING_KEY` (config `superRefine`), and scheduling a self-serve
  erasure **fails closed** without a signer, so there is never an erased-but-unsignable tenant. For
  dev/test/CI ergonomics, a non-prod context with no key generates an **ephemeral** Ed25519 keypair at
  startup (with a stderr warning; not verifiable across restarts).
- **Post-erasure fail-soft.** Erasure is irreversible and runs **before** signing; if signing throws
  after the data is gone (rare — the key was validated at startup), the engine records the certificate
  **unsigned**, emits an `error`-outcome audit event, and **alerts the operator** — it never rolls back
  (the data cannot be un-erased).
- **Verification surface.** The operator publishes the **public Ed25519 JWK**
  (`tenantforge erasure-cert-pubkey` / `TenantForge.erasureCertificatePublicKey()`); an auditor/data
  subject verifies a certificate offline with `tenantforge erasure-cert-verify --jws … --pubkey …`
  (or the pure `verifyErasureCertificate(jws, jwk)` function).
- **Deferred — KMS/HSM signer.** A KMS-resident signer can drop in behind the same `CertificateSigner`
  port later (the engine depends on the abstraction, not the in-process key); not built now.

## Dashboard parity (per-feature web-view rule)

The project's "web dashboard per feature" rule (`CLAUDE.md`) requires every new feature to ship a
**browser view** of its output, in addition to the CLI/HTTP/MCP surfaces. For these self-serve
features the **customer portal SPA is that web view** — and the correct one: the features are
_customer-facing_, so the human-facing window is the **customer portal**, not the operator dashboard.
Putting customer self-serve cancel/erasure/payment on the **operator** dashboard would reintroduce the
exact ADR-0004 concern this ADR carefully scopes around (money/lifecycle off the operator surface).
So parity is satisfied as: payment-method, plan, invoices/billing, usage, cancel, export, and erasure
(incl. the undo-window status) each have a portal SPA view (`tenantforge/portal/`); the operator
dashboard stays **read-only** per ADR-0004. The CLI/HTTP/MCP automation surfaces remain as before
(the destructive sweep executor is CLI/worker-only — `erasure-sweep`).

## Tenant self-serve compliance evidence (added 2026-06-25 — ADR-0011 Phase 3d)

The customer portal now also exposes a **self-scoped, read-only "Download my compliance evidence"**
surface ([ADR-0011](0011-compliance-evidence-layer.md) decision #5 → portal read path; threat-model
**B8e**): a tenant lists **its own** persisted evidence-bundle manifests, downloads a specific **own**
signed bundle + the public verification key, and may **self-generate** its own current bundle on
demand. This is governed by this ADR's invariant exactly like the other portal actions — the tenant
id is **server-derived from the session, never client-supplied**, so it can only ever reach the
calling tenant's own evidence (no cross-tenant/BOLA). It reuses the portal session /
`TenantAuthenticator`, **not** the operator RBAC `evidence:read`. The self-generate is
**read-only/non-destructive** (assembly + sign + persist, server-scoped), so it is **NOT** gated by
`TENANTFORGE_PORTAL_SELFSERVE_DESTRUCTIVE` (that flag gates only the cancel/erasure pair); it sits
behind its own benign default-OFF rollout flag `TENANTFORGE_PORTAL_SELFSERVE_EVIDENCE` purely for
staged rollout. The operator evidence surfaces (dashboard/CLI/HTTP/MCP, fleet-scoped) are unchanged.
