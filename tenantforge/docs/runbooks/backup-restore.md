# Runbook: Backup & Restore

> Two distinct layers: the **control-plane registry** (our metadata DB) and **tenant data** (each
> tenant's own Neon project). Rules: `@rules/workflow-data-lifecycle.md`, `@rules/topic-reliability.md`.

## When to use

- Data loss/corruption, recovery during an incident, or a **scheduled restore drill** (an untested
  backup is not a backup).

## The two layers

| Layer                  | What it holds                                                                                                               | Backup mechanism                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Control-plane registry | Tenant **metadata** + fleet-migration state (`tf_tenants`, `tf_migrations`, `tf_tenant_migrations`) — **no tenant content** | Neon PITR on the control-plane project                                                       |
| Tenant data            | Each tenant's actual data                                                                                                   | Neon PITR / branching on **that tenant's** project; offboarded tenants → the export artifact |

## Prerequisites & access

- Neon console / API access to the control-plane project and the relevant tenant project(s).
  Restore into an **isolated branch** first; know RPO/RTO.

## Steps — control-plane registry

1. In Neon, identify the recovery point for the control-plane project.
2. Restore to a **new branch** (PITR) and point a verification instance at it via `DATABASE_URL`.
3. Verify: `psql "$DATABASE_URL" -c "SELECT status, count(*) FROM tf_tenants GROUP BY status;"` matches
   expectations; spot-check known tenants. Only then cut over.
   - Restoring the registry restores **metadata only** — it does not touch tenant data. If the
     registry is ahead of reality (e.g. a tenant project was deleted), reconcile status manually.

## Steps — a tenant's data

1. Use Neon PITR / branch restore on **that tenant's** project (by `neon_project_id` from `tf_tenants`).
2. For an **offboarded** (`offboarding`) tenant: it is **archived, not deleted** — the Neon project is
   retained (scaled to zero) and the connection secret is intact. "Restore" = `tenantforge resume <id>`
   (un-archive back to active) during the retention window; no data recovery needed.
3. For a **purged** (`deleted`) tenant: the project is gone and the secret was crypto-shredded —
   **unrecoverable by design** (`@rules/std-privacy.md`). This is why `purge` runs only after the
   retention window.

## Verification

- Row counts / checksums / spot-checks match; the app connects and passes smoke tests. Record actual
  RTO vs. target.

## Rollback / abort

- Restore into an isolated branch first; cut over only once verified. Snapshot the current
  (damaged) state before overwriting, for forensics.

## Escalation

- Page `<DBA/on-call>`; data-loss incidents → [`incident-response.md`](./incident-response.md).

## Related

- `rollback.md`, `incident-response.md`; `@rules/workflow-data-lifecycle.md`.

---

_Last validated: not yet drilled (alpha). Owner: TenantForge maintainers._
