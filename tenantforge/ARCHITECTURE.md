# TenantForge — v1 Architecture & Scope

_Status: **stable** (v0.3.0) — feature-complete and hardened: pure core (100% coverage), Neon-API
provisioning + Postgres registry / encrypted secret-store adapters, the full tenant lifecycle,
connection routing, fleet-migration orchestration, per-tenant observability + metering, residency
enforcement, and a Neon-native queue + worker — across the library, CLI, HTTP, and MCP entrypoints.
All hardening gates are drilled: STRIDE threat model + abuse tests, auth/RBAC/rate-limiting, the
load/soak harness, and the runbook game-day (local + CI), `NEON_API_KEY` rotation, and a PITR
row-level recovery — all green against a non-prod org. Tracked Low residuals + deferred alternate
adapters live in `docs/security/threat-model.md`. Decisions
trace to
[`../research/product-concepts.md`](../research/product-concepts.md) (#2) and
[`../research/teardown-finalists.md`](../research/teardown-finalists.md)._

## 1. Positioning

TenantForge is the **control plane for database-per-tenant SaaS**: signup → provision an isolated
Neon project per customer → route connections → run schema migrations across the whole fleet →
handle suspend / offboard / export → pick a per-tenant region. It turns "correct multi-tenancy" into
a managed primitive.

- **The value is structural:** physical isolation (one Postgres project per tenant) gives a strong
  **compliance** story (HIPAA/SOC2 narrative, per-region data residency) and removes the per-tenant
  **always-on DB tax** — idle tenants scale to zero and cost ~$0. Neon's high project ceiling
  (thousands of projects) makes this economical; instant API provisioning makes it fast.
- **The moat is the workflow + DX**, not the isolation trick (anyone can call the Neon API once):
  fleet-wide migration orchestration with rollback, lifecycle automation, connection routing, and
  per-tenant observability/metering — the parts that are painful to build correctly.
- **Composition:** TenantForge is the **shell** the other tools plug into. Each tenant's isolated
  Postgres can also host that tenant's vectors via **VectorNest** (`consumes: rag.*`) — "one Postgres
  = relational + vectors" per tenant.

## 2. v1 scope

**In (v1):**

- **Provision** a tenant: create a Neon project (region-selectable), capture its connection URI,
  record it in the control-plane **tenant registry**. Idempotent + resumable.
- **Tenant registry** (the control plane's own Postgres): tenant id, slug, region, status, project
  id, created/updated — **no tenant data**, only metadata.
- **Connection routing:** resolve a tenant → its connection (pooled), with tenant context derived
  **server-side** from the authenticated principal (never a client-supplied tenant id).
- **Fleet migration orchestration:** apply a versioned schema migration across all tenant projects —
  batched, idempotent, resumable, with per-tenant success/failure tracking and rollback guidance
  (the "noisy migration" risk is the hard part; treat it as first-class).
- **Lifecycle:** suspend / resume / **offboard** (archive: retain the project scaled-to-zero,
  reversible during retention) → **purge** (irreversible delete) — privacy / data-lifecycle.
- Entrypoints: **library + CLI** (core), **HTTP control-plane API** + **MCP server** (management).

**Now in (previously deferred):**

- **ResidencyRouter (#16)** — `selectRegion` chooses a residency-compliant region from a jurisdiction
  within the org allow-list; `provision` auto-selects when given a `residency` but no region.
- **ErasureEngine (#17)** — `TenantForge.erase` / `createErasureEngine`: automated, audited
  right-to-erasure (export → delete project → crypto-shred secret → verify → certificate).

**Out (deferred / other tools):**

- Cross-tenant analytics / fan-in reporting (a separate read-side concern).
- Per-tenant billing/usage metering (graduates into its own concern; v1 emits the events).
- Shared-schema (`tenant_id`) multitenancy — explicitly **not** TenantForge's model.

## 3. Architecture style (per the SSDLC rules)

**Functional core / imperative shell + ports & adapters.** Pure logic (tenant slug/region
validation, migration plan/state machine, routing decisions) has no I/O and is unit-testable without
mocks; all I/O lives behind injected adapters.

**Ports (interfaces the core owns):**

- `ProvisioningProvider` — create/delete a tenant database (Neon API adapter: projects + branches).
- `TenantRegistry` — persist/lookup tenant records (Postgres adapter, control-plane DB).
- `MigrationRunner` — apply a migration to one tenant connection; the orchestrator fans out over the
  fleet with bounded concurrency + per-tenant status.
- `ConnectionRouter` — resolve a tenant → a (pooled) connection.

Adapters injected at a composition root per entrypoint. The **Neon API is an untrusted upstream**
(timeouts, bounded retries, schema-validate responses).

## 4. Data model (control-plane registry — NOT tenant data)

| Table                  | Key columns                                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `tf_tenants`           | `id`, `slug` (unique), `region`, `status` (provisioning/active/suspended/offboarding/deleted), `neon_project_id`, `metadata jsonb`, timestamps |
| `tf_migrations`        | `id`, `version`, `checksum`, `applied_at` — the fleet migration catalog                                                                        |
| `tf_tenant_migrations` | `tenant_id`, `migration_id`, `status`, `error`, `applied_at` — per-tenant fleet-migration state (PK `(tenant_id, migration_id)`)               |

Tenant **content** never lives here — only the metadata to provision, route, and orchestrate.

## 5. Key flows

**Provision** — validate slug/region → `ProvisioningProvider.createTenant` (Neon project, chosen
region) → store the record + connection secret reference → optionally run baseline migrations →
return tenant handle. Idempotent on slug; resumable if interrupted mid-provision.

**Route** — authenticated principal → tenant id (server-side) → `ConnectionRouter` returns a pooled
connection scoped to that tenant's project. Never trust a client-supplied tenant id (BOLA).

**Fleet migration** — register a versioned migration → orchestrator iterates tenants in bounded
batches, applies idempotently, records per-tenant status; failures are isolated (one tenant failing
doesn't block others) and surfaced for retry/rollback. **Migrations must be backward-compatible
(expand/contract)** so app + schema deploy independently fleet-wide.

**Offboard** — suspend → export the tenant's data → delete the Neon project → mark deleted. Honors
retention/erasure obligations.

## 6. Discoverability (harness/agent integration)

- Publishes [`neon-tool.json`](./neon-tool.json) → found by globbing `**/neon-tool.json`.
- **MCP server** exposes `tf_provision`, `tf_tenant`, `tf_list_tenants`, `tf_migrate_fleet`,
  `tf_suspend`, `tf_offboard` over stdio.
- `provides` (`tenant.provision`, `tenant.route`, `tenant.lifecycle`, `tenant.migrate`) and
  `consumes` (`rag.*` from VectorNest) describe how it composes into a SaaS.

## 7. Security & SSDLC compliance

- **Tenant isolation is the security boundary** — a cross-tenant leak is a critical incident. Physical
  isolation (project-per-tenant) is the strongest model; still derive tenant context server-side and
  test cross-tenant access explicitly (`@rules/topic-multi-tenancy.md`).
- **Least privilege:** the control plane holds a Neon API key (provisioning) and its own registry DB
  credential — scoped, from a secret manager, never per-tenant "god" creds. Per-tenant connection
  secrets stored/handled with least privilege.
- **Neon API as untrusted upstream:** timeouts, bounded retries, validate responses
  (`@rules/topic-api-consumption.md`). Account is **org-scoped** → operations need `NEON_ORG_ID`.
- **Privacy/residency:** per-tenant region; offboard = archive (retain, scaled-to-zero) then purge
  (irreversible delete + crypto-shred the connection secret) after retention
  (`@rules/std-privacy.md`). No tenant data in the control-plane DB; no real tenant data in non-prod.
- **Fleet-migration safety:** idempotent, resumable, rollback-aware; a fleet change is a release
  (threat-model + runbook it).
- **Threat model (STRIDE):** the trust boundaries, their mitigations, residual risks, and the
  abuse-test mapping are documented in [`docs/security/threat-model.md`](./docs/security/threat-model.md).

## 8. Tech stack

- **Node LTS + TypeScript (strict, ESM).** `pg`/`postgres.js`; `zod` validation.
- **Neon API** for project-per-tenant provisioning; **branching** for tenant clone/preview;
  **scale-to-zero** so idle tenants cost ~$0.
- CLI: `citty`. HTTP: a lightweight framework (e.g. Hono — matches VectorNest). MCP:
  `@modelcontextprotocol/sdk`. Tests: `vitest` + control-plane-DB-backed integration on an ephemeral
  Neon branch.

## 9. Proposed source tree

```
tenantforge/
  neon-tool.json  README.md  ARCHITECTURE.md  CLAUDE.md  .env.example
  package.json  tsconfig.json
  migrations/              # control-plane registry schema (0001_init.sql ...)
  src/
    core/                  # pure: slug/region validation, migration plan/state machine, routing
    ports/                 # ProvisioningProvider, TenantRegistry, MigrationRunner, ConnectionRouter
    adapters/              # neon-api/, neon-pg/ (registry), ...
    app/                   # composition roots: lib.ts, cli.ts, http.ts, mcp.ts
  test/                    # unit (core) + integration (Neon branch)
  openapi.yaml             # HTTP control-plane API contract
```

## 10. Milestones

- **Week 1 (walking skeleton):** registry schema + migrations; `ProvisioningProvider` (Neon API) +
  `TenantRegistry` (pg) adapters; `provision` + `list` + `get` via **library + CLI**; unit tests on
  the pure core; one integration test against an ephemeral Neon branch (provision → record → delete).
- **Month 1:** fleet migration orchestration (batched, resumable, per-tenant status + rollback);
  connection routing; suspend/offboard with export+delete; HTTP control-plane API + MCP server;
  per-tenant observability; coverage gates green; docs + runbooks.

## 11. How it composes

TenantForge is the **SaaS shell**: it provisions and governs per-tenant Postgres, and other tools run
**inside** each tenant — most directly **VectorNest** (the tenant's isolated vector store). Tools stay
standalone and discoverable; the SaaS is their composition.
