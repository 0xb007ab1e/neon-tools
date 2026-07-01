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
2. For an **offboarded** (`offboarding`) tenant with the default **neon-archive** exporter: it is
   **archived, not deleted** — the Neon project is retained (scaled to zero) and the connection secret
   is intact. "Restore" = `tenantforge resume <id>` (un-archive back to active) during the retention
   window; no data recovery needed.
   - With the **pg-dump** exporter instead, the offboard wrote a `pg_dump` artifact to the object
     store (the `ExportResult.location`, e.g. `file://…/tenants/{id}/{ts}.dump`). Restore it into a
     fresh project with `pg_restore -d "<new tenant connection URI>" <artifact>`.
3. For a **purged** (`deleted`) tenant: the project is gone and the secret was crypto-shredded —
   **unrecoverable by design** (`@rules/std-privacy.md`). This is why `purge` runs only after the
   retention window.

## Steps — scheduled snapshots (Neon branches)

Snapshots are named Neon branches (`snapshot-<ms>`), instant + copy-on-write. They protect against
**corruption / bad migrations**, not project deletion (a branch lives inside the project).

1. **Take** one: `tenantforge snapshot <tenant-id>` → prints the branch id. On a schedule (cron /
   CronJob): `tenantforge snapshot-fleet` snapshots every active tenant (failure-isolated).
2. **Prune** by retention on a schedule: `tenantforge prune-snapshots --max-count 7`
   (and/or `--max-age-days 30`) — keeps the newest, drops the rest; failure-isolated.
3. **Restore** (DESTRUCTIVE — overwrites live tenant data): `tenantforge restore-snapshot <tenant-id>
<branch-id> --yes`. Prefer branching off the snapshot in the Neon console first to verify, then
   restore. For recovery beyond the retention/PITR window, use the `pg_dump` archive instead.

## Steps — off-Neon archive (pg_dump → object store)

The durable, long-term tier — archives **survive project deletion** (unlike branches). Enabled when
`TENANTFORGE_EXPORT_DIR` (the export object store) is configured.

1. **Archive** one: `tenantforge archive <tenant-id>` → prints the artifact location
   (`archives/{id}/{ts}.dump`). On a schedule: `tenantforge archive-fleet` (failure-isolated).
2. **Retention** is the **object store's lifecycle policy** (e.g. an S3/GCS lifecycle rule on the
   `archives/` prefix) — TenantForge does not delete archives. Configure the bucket rule to your
   retention/compliance window. (Filesystem export is dev-only; no lifecycle.)
   - **Prod-readiness (gap #15):** the same applies to the **`object-store` evidence** backend — its
     `evidence-prune` sweep removes only the manifest index, not the at-rest body, so a bucket
     lifecycle rule must match `TENANTFORGE_EVIDENCE_RETENTION_DAYS` (startup warns for that combo).
     TenantForge cannot inspect the bucket policy, so **verifying the lifecycle rule exists is a
     prod-readiness checklist item.** (`pg` evidence/registry data self-deletes on prune — no rule needed.)
3. **Restore** an archive into a fresh project: `pg_restore -d "<new tenant connection URI>"
<artifact>` (same as the offboard pg-dump path above).

## Verification

- Row counts / checksums / spot-checks match; the app connects and passes smoke tests. Record actual
  RTO vs. target.

## Rollback / abort (reverting a PITR restore)

- Restore into an isolated branch first; cut over only once verified. Snapshot the current
  (damaged) state before overwriting, for forensics.

How to **undo** a restore depends on how you ran it:

- **Restored into a NEW branch** (the recommended path above): the primary/`main` was never touched —
  there is nothing to revert. Just delete the verification branch:
  ```bash
  neon branches delete <restore-branch>        # older CLI alias: neonctl
  ```
  (Console → **Branches** → the restore branch → **Delete**.) This is also the clean drill teardown.
- **In-place Instant Restore** (reset a branch to an earlier point): Neon **auto-creates a backup
  branch** of the pre-restore head, named `<branch>_old_<head_timestamp>`. Revert by Instant-Restoring
  the branch again **from that backup**:
  ```bash
  neon branches restore <target-branch> <backup-branch-id-or-name>
  ```
  (Console → **Backup & Restore** → target = the restored branch → **From another branch** → pick
  `<branch>_old_<…>` → **Restore from latest data (head)**.) Note: a backup branch created by
  restoring a **root** branch cannot be deleted — rename it or drop its databases to reclaim space.
  Ref: [Neon branch restore](https://neon.com/docs/guides/branch-restore).

## Escalation

- Page `<DBA/on-call>`; data-loss incidents → [`incident-response.md`](./incident-response.md).

## Related

- `rollback.md`, `incident-response.md`; `@rules/workflow-data-lifecycle.md`.

---

_Last validated: 2026-06-18 — **Neon PITR restore drilled** against a non-prod org: a canary row inserted into the primary registry was recovered in a point-in-time branch (row-level recovery verified end-to-end, then the marker cleaned up). The offboard→resume "restore" path and the registry status query were also exercised. See [drill-report](./drill-report.md). Owner: TenantForge maintainers._
