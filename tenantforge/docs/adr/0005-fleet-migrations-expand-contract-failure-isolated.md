# ADR 0005 — Fleet migrations: expand/contract, failure-isolated, resumable

- **Status:** Accepted (2026-06-22)

## Context

With a database per tenant (ADR-0001), a schema change isn't one `ALTER` — it must apply across the
whole fleet of per-tenant projects. Doing that naively (a loop that stops on the first error, or a
non-backward-compatible change) risks a half-migrated fleet, app/schema incompatibility, and no safe
way to resume or roll back.

## Decision

A fleet migration is treated as a **release** (`@rules/workflow-release.md`):

- **Backward-compatible (expand/contract)** changes only, so app and schema can deploy independently
  and roll back safely.
- **Failure-isolated + idempotent + resumable + batched:** per-tenant success/failure is tracked;
  one tenant's failure never blocks the others; a re-run applies only what's missing, in order,
  **stopping at a tenant's first failure** (ordered-dependency-safe).
- **Canary first:** migrate one tenant and abort the rollout if it fails.
- **Drift is observable + reconcilable:** `fleetStatus()` reports which tenants are behind/failed vs
  the target; `reconcileFleet` brings them up. A read-only **plan** (CLI/HTTP/dashboard) previews
  without needing SQL; execution needs the SQL catalog and is gated.

## Alternatives considered

- **One transaction across the fleet** — impossible (separate databases) and undesirable (lock the
  world).
- **Best-effort loop, abort on first error** — rejected: leaves the fleet in an unknown,
  unresumable state.
- **Destructive (non-backward-compatible) migrations** — rejected: no safe independent rollback.

## Consequences

- A fleet change is safe to interrupt and resume; a bad tenant is quarantined, not fleet-fatal.
- Operators get drift visibility and a previewable, gated reconcile path; rollback has a runbook.
- Migrations must be authored expand/contract (a constraint on change design, by intent).
