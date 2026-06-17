# TenantForge

> **The control plane for database-per-tenant SaaS, on Neon.**
> Provision an isolated Neon project per customer, route connections, run schema migrations across
> the whole fleet, and handle suspend / offboard / residency — so you get hard data isolation and a
> clean compliance story without building tenant provisioning, routing, and lifecycle yourself.

**Status:** `scaffold` — directory, design, manifest, and project rules are laid down; no
implementation yet. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the design, scope, and milestones.

## Why

Multi-tenant SaaS usually picks shared-schema (`tenant_id`) and inherits a one-bug-from-a-breach
isolation risk, or pays an always-on database per tenant. Neon changes the economics: a Postgres
**project per tenant** gives **physical isolation** (great for HIPAA/SOC2 + per-region residency),
and **scale-to-zero** means idle tenants cost ~$0. TenantForge is the managed control plane over
that primitive — the provisioning, routing, fleet-migration orchestration, and lifecycle that are
painful to build correctly.

## What v1 will do

- **Provision** a tenant → an isolated Neon project (region-selectable), recorded in a control-plane
  registry. Idempotent + resumable.
- **Route** an authenticated principal → its tenant's connection (tenant context derived
  server-side — never from the client).
- **Migrate the fleet** — apply a versioned, backward-compatible schema change across all tenants,
  batched/resumable with per-tenant status + rollback.
- **Lifecycle** — suspend / resume / **offboard** (export + delete the tenant's project).
- Use it as a **library**, a **CLI**, an **HTTP control-plane API**, or an **MCP server**.

## Composition

TenantForge is the **SaaS shell** the other collection tools run inside. Most directly, each tenant's
isolated Postgres can host that tenant's vectors via [**VectorNest**](../vectornest/) — one database,
relational + vectors, per tenant. It `consumes` `rag.*` and `provides` `tenant.*` capabilities (see
[`neon-tool.json`](./neon-tool.json)).

## Configuration

Secrets come from the environment (never committed). See [`.env.example`](./.env.example):
`NEON_API_KEY` + `NEON_ORG_ID` (provision projects — the account is org-scoped), `DATABASE_URL` (the
control-plane registry DB), and `TENANTFORGE_HTTP_TOKEN` (HTTP server).

## Discoverability & rules

Publishes [`neon-tool.json`](./neon-tool.json) per the collection's
[discovery convention](../TOOLS.md). Inherits [`CLAUDE.md`](./CLAUDE.md) (TypeScript-service SSDLC
ruleset, multi-tenancy-focused).
