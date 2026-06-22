# ADR 0001 — Database-per-tenant (physical isolation), not shared-schema

- **Status:** Accepted (2026-06-22)

## Context

Multi-tenant SaaS must isolate tenant data. The common choice is **shared-schema** — one database
with a `tenant_id` column on every row — which is cheap but leaves isolation entirely to query
discipline: a single missing `WHERE tenant_id = ?` is a cross-tenant breach. The alternative,
**a database per tenant**, gives physical isolation but is historically expensive (an always-on DB
per tenant). Neon changes that economics: project-per-tenant provisioning is ~1s via API and idle
projects **scale to zero** (≈ $0).

## Decision

Each tenant gets its **own isolated Neon project** (a dedicated Postgres). TenantForge is the control
plane that provisions, routes to, migrates, and lifecycles those per-tenant projects. There is **no
shared tenant-data schema** and no `tenant_id`-column model anywhere in the product.

## Alternatives considered

- **Shared-schema (`tenant_id`)** — rejected: isolation is one query bug from a breach; row-level
  security helps but the blast radius of a mistake is the whole fleet. (`@rules/topic-multi-tenancy.md`
  calls the pool model the highest-leak-risk option.)
- **Schema-per-tenant (bridge)** — rejected: still one database/credential; weaker isolation than
  separate projects and no scale-to-zero economics.

## Consequences

- **Hard isolation** by construction — strong for HIPAA/SOC2 and per-region residency (ADR-0003,
  residency enforcement). A cross-tenant leak would require a provisioning/routing bug, not a
  forgotten predicate.
- Cost scales with _active_ tenants, not total — idle tenants are ≈ $0 (scale-to-zero).
- The hard problems move to the **control plane** (provisioning, connection routing, fleet
  migrations, lifecycle) — which is exactly what TenantForge owns. Fleet schema changes need
  orchestration (ADR-0005) rather than a single `ALTER`.
- Per-tenant connection secrets must be stored and routed (ADR-0006).
