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

| #   | Boundary                                           | Crossing                            |
| --- | -------------------------------------------------- | ----------------------------------- |
| B1  | Internet/operator → HTTP control-plane API         | admin requests over the network     |
| B2  | LLM/agent → MCP server                             | tool calls from an autonomous agent |
| B3  | Application → connection routing (`getConnection`) | resolve a tenant's DB connection    |
| B4  | Tenant ↔ tenant                                    | the core isolation guarantee        |
| B5  | Service → Neon API                                 | calls to an external upstream       |
| B6  | Queue producer → lifecycle consumer                | untrusted command payloads          |
| B7  | Service → SecretStore / registry / object store    | secret + metadata persistence       |
| B8  | Tenant (customer) → self-serve portal              | a tenant reads its own account data |

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

| Threat                                    | Test                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BOLA / cross-tenant bleed (B3/B4)         | `getConnection(A)` returns A's project/URI, never B's (two tenants)                                                                                                                                                                                                                                                                                                              |
| Fail-closed routing (B3)                  | every non-`active` status is non-routable; active-but-no-secret fails closed                                                                                                                                                                                                                                                                                                     |
| Illegal lifecycle transition (B3)         | exhaustive transition matrix — every disallowed `(from,to)` rejected                                                                                                                                                                                                                                                                                                             |
| Excessive agency (B2)                     | the MCP tool set exposes **no** `purge`/`purge-expired`                                                                                                                                                                                                                                                                                                                          |
| Spoofing (B1)                             | HTTP returns 401 on a missing/incorrect bearer token                                                                                                                                                                                                                                                                                                                             |
| Broken function authZ (B1, API5)          | a `readonly` operator gets 403 on a mutating route; `admin` may mutate                                                                                                                                                                                                                                                                                                           |
| DoS / rate limit (B1)                     | over-limit requests get 429 + `Retry-After`; the window refills                                                                                                                                                                                                                                                                                                                  |
| Untrusted payload (B6)                    | invalid queue payload is dead-lettered, never handled                                                                                                                                                                                                                                                                                                                            |
| Residency (B7)                            | provisioning fails closed outside the region allow-list / required jurisdiction                                                                                                                                                                                                                                                                                                  |
| Secret disclosure (B7)                    | connection URI never appears in events/registry records                                                                                                                                                                                                                                                                                                                          |
| Cross-tenant portal read (B8)             | `tenant{Charges,Refunds}(A)` never return B's; portal reads no tenant id from the request; `tenantSummary` omits metadata/secrets                                                                                                                                                                                                                                                |
| Cross-tenant portal **mutation** (B8w)    | a session for A cannot change B's plan / payment method / cancel / erase B; no route accepts a `tenantId` (`portal-selfserve.test.ts`)                                                                                                                                                                                                                                           |
| CSRF on mutations (B8w)                   | a state-changing POST without a valid signed CSRF token, with another tenant's token, or cross-site is rejected (`portal-selfserve.test.ts`)                                                                                                                                                                                                                                     |
| Step-up bypass (B8w)                      | cancel / erasure without a verifying control-plane second factor is rejected; a code is single-use + action-bound (`portal-selfserve*.test.ts`)                                                                                                                                                                                                                                  |
| Idempotency replay (B8w)                  | a duplicate plan-change with the same `Idempotency-Key` applies **once** (replays the response) (`portal-selfserve.test.ts`)                                                                                                                                                                                                                                                     |
| Erasure undo window (B8w)                 | cancel before the window → project intact; after → erased + certificate; a cancel-vs-execute race can't double-delete; redelivery is idempotent (`portal-selfserve-facade.test.ts`, `pending-erasure-store.test.ts`)                                                                                                                                                             |
| Unverified / cross-customer payment (B8w) | a client's "card saved" without a server-verified SetupIntent is rejected, and a SetupIntent whose `customerRef` ≠ the tenant's is rejected (F5) (`portal-selfserve*.test.ts`)                                                                                                                                                                                                   |
| Cancel billing exclusion (B8w)            | a cancelled (`offboarding`) tenant is absent from the active set the billing/dunning sweeps charge (`portal-selfserve-facade.test.ts`)                                                                                                                                                                                                                                           |
| Signed erasure certificate (B8w)          | sign→verify round-trips; a **tampered** cert, the **wrong public key**, and **alg-confusion** (`alg:none`/`HS*`/non-EdDSA) all fail closed; always-signed engine; prod startup fail-fast without a key; post-erasure signing failure fails soft (no rollback) (`erasure-cert.test.ts`, `certificate-signer.test.ts`, `erasure-engine.test.ts`, `config-erasure-signing.test.ts`) |

---

_Last reviewed: 2026-06-18 (v0.3.0 stable). Owner: TenantForge maintainers. Review on any trust-boundary change._
