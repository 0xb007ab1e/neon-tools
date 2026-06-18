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

## STRIDE per boundary → mitigation (and where it lives in code)

### B1 — HTTP control-plane API (admin)

- **S (spoofing):** **per-operator** bearer credentials (`id:role:token`) with **constant-time**
  token compare (`src/app/http-server.ts`); tokens are secrets from env (`workflow-secrets`),
  rotatable (`docs/runbooks/secret-rotation.md`). A single-admin token shorthand remains for simple
  deploys. **AuthZ (RBAC, API5):** mutating routes require the `admin` role; `readonly` → 403.
- **T (tampering):** request bodies validated with `zod` before use; TLS terminated at the edge
  (deploy concern). **I (disclosure):** the API **never returns connection URIs** — `provision`
  reports only that a secret was issued; errors return a stable shape, not internals
  (`@rules/topic-error-handling.md`). **R (repudiation):** structured, tenant-scoped audit events
  (`src/core/observability.ts`). **D (DoS):** a 1 MB request
  **body-size cap** + a **per-principal fixed-window rate limit** (429 + `Retry-After`) are enforced
  in-app (`src/app/http-server.ts`). **E (EoP):** this is an _admin_ control plane: the
  `:id` is operator-supplied by design (not a tenant impersonating another); least-privilege token +
  network ACLs gate it. The destructive purge route additionally requires an explicit `confirm: true`.

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

## Residual risks (tracked)

- **R1 — addressed (Low residual).** Per-operator credentials + RBAC are now in-app (admin/readonly,
  constant-time compare). Remaining: tokens are static bearer secrets — phishing-resistant,
  externally-managed identity (OIDC) is a future enhancement, not a gap for an admin control plane.
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
promotion (v0.3.0)**. The remaining items above are accepted **Low residuals**, owned by the
maintainers and time-boxed at the next review (not promotion blockers).

## Abuse cases → tests

Each boundary's key threat is pinned by a negative/abuse test (master §4, `@rules/topic-multi-tenancy.md`):

| Threat                            | Test                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------- |
| BOLA / cross-tenant bleed (B3/B4) | `getConnection(A)` returns A's project/URI, never B's (two tenants)             |
| Fail-closed routing (B3)          | every non-`active` status is non-routable; active-but-no-secret fails closed    |
| Illegal lifecycle transition (B3) | exhaustive transition matrix — every disallowed `(from,to)` rejected            |
| Excessive agency (B2)             | the MCP tool set exposes **no** `purge`/`purge-expired`                         |
| Spoofing (B1)                     | HTTP returns 401 on a missing/incorrect bearer token                            |
| Broken function authZ (B1, API5)  | a `readonly` operator gets 403 on a mutating route; `admin` may mutate          |
| DoS / rate limit (B1)             | over-limit requests get 429 + `Retry-After`; the window refills                 |
| Untrusted payload (B6)            | invalid queue payload is dead-lettered, never handled                           |
| Residency (B7)                    | provisioning fails closed outside the region allow-list / required jurisdiction |
| Secret disclosure (B7)            | connection URI never appears in events/registry records                         |

---

_Last reviewed: 2026-06-18 (v0.3.0 stable). Owner: TenantForge maintainers. Review on any trust-boundary change._
