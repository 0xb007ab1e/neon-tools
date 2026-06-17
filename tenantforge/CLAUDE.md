# TenantForge — project rules

> Inherits the master SSDLC ruleset (~/.claude/CLAUDE.md) automatically.
> Standalone tool in the Neon collection; see ../TOOLS.md for the discovery convention.

## Applied rule modules

@~/.claude/rules/lang-typescript.md
@~/.claude/rules/topic-multi-tenancy.md # THE core concern: project-per-tenant isolation
@~/.claude/rules/std-owasp.md
@~/.claude/rules/std-owasp-api.md # HTTP control-plane API (BOLA is the top risk)
@~/.claude/rules/std-owasp-proactive.md
@~/.claude/rules/std-cwe.md
@~/.claude/rules/topic-authn-authz.md # per-tenant authZ; tenant context server-side only
@~/.claude/rules/topic-api-design.md # control-plane API contract + versioning
@~/.claude/rules/topic-database.md # registry schema, fleet migrations (expand/contract)
@~/.claude/rules/topic-iac-cloud.md # provisions cloud resources (Neon projects) — least privilege
@~/.claude/rules/topic-api-consumption.md # the Neon API is an untrusted upstream
@~/.claude/rules/topic-reliability.md # fleet-wide orchestration: retries, idempotency, backpressure
@~/.claude/rules/topic-logging-observability.md
@~/.claude/rules/std-zero-trust.md # no network trust; per-request, per-tenant authZ
@~/.claude/rules/std-privacy.md # per-tenant PII, residency, export + erasure on offboard
@~/.claude/rules/std-supplychain.md
@~/.claude/rules/workflow-cicd.md
@~/.claude/rules/workflow-threat-model.md # provisioning + multi-tenancy add trust boundaries
@~/.claude/rules/workflow-release.md # a fleet migration is a release (rollout + rollback)
@~/.claude/rules/workflow-incident-response.md
@~/.claude/rules/workflow-runbooks.md
@~/.claude/rules/topic-testing.md

@~/.claude/rules/topic-event-driven.md # queue-driven lifecycle: MessageQueue port + idempotent, DLQ-on-poison consumer

# @~/.claude/rules/std-soc2.md / std-hitrust.md # enable under the relevant compliance scope

## Stack

- Runtime: Node LTS; TypeScript strict; ESM.
- Control-plane registry: Neon Postgres (tenant metadata only); query layer `pg`/`postgres.js`; `zod`.
- Provisioning: the **Neon API** (project-per-tenant; branching; scale-to-zero). Account is
  **org-scoped** → operations require `NEON_ORG_ID`.
- Entrypoints: library, CLI (`citty`), HTTP control-plane API (Hono), MCP server
  (`@modelcontextprotocol/sdk`).

## Project-specific rules

- **Tenant isolation is the security boundary.** Model is **physical** (one Neon project per tenant),
  not shared-schema `tenant_id`. A cross-tenant leak is a critical incident.
- **Tenant context is derived server-side** from the authenticated principal — **never** from a
  client-supplied tenant id (BOLA — `@rules/std-owasp-api.md`). Test cross-tenant access explicitly.
- **The control-plane DB holds metadata only** (tenant registry + fleet-migration state) — never
  tenant content. No real tenant data in non-prod.
- **Fleet migrations** are idempotent, resumable, batched, and **backward-compatible (expand/contract)**;
  per-tenant success/failure is tracked and a failure in one tenant never blocks others. A fleet
  change is a release — runbook + rollback it (`@rules/workflow-release.md`).
- **Neon API is an untrusted upstream:** timeouts, bounded retries, schema-validate responses
  (`@rules/topic-api-consumption.md`). Least-privilege API key + registry credential from env/secret
  manager — never per-tenant shared "god" creds (`@rules/workflow-secrets.md`).
- **Lifecycle honors privacy:** per-tenant region (residency); offboard = export + irreversible
  delete (`@rules/std-privacy.md`).
- Keep the pure `core/` free of I/O so it's unit-testable without mocks; provisioning/registry/
  routing are integration-tested against an ephemeral Neon branch in CI.
- Secrets from env only (`.env` git-ignored, `.env.example` committed).
