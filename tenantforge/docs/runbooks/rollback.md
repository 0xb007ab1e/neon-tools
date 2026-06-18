# Runbook: Rollback (Control-Plane Service)

> Reverting a bad **control-plane service** release. For reverting a tenant **fleet** schema
> migration, use [`fleet-migration-rollback.md`](./fleet-migration-rollback.md). Rules:
> `@rules/workflow-release.md`.

## When to use

- A control-plane release caused an SLO regression, elevated errors, or provision/routing failures,
  and forward-fix isn't fast enough.

## Severity / impact

- Usually SEV2+. Bias to rolling back during an active regression.

## Prerequisites & access

- The previous known-good artifact digest; deploy role. Know whether the release included a
  **control-plane registry** migration.

## Steps

1. Halt the in-progress rollout / freeze promotion.
2. **Check registry migrations:** if the release applied a control-plane registry change, confirm it
   was backward-compatible (expand/contract — `@rules/topic-database.md`). If so, app rollback is
   safe. If a registry change is **not** reversible, do **not** naively roll back — escalate and
   forward-fix, or restore per [`backup-restore.md`](./backup-restore.md).
3. Redeploy the previous known-good artifact (or shift traffic back to blue/stable).
4. Disable the offending feature flag if the change was flag-gated (fastest path).

## Verification

- `/health` green; provision/routing error rates back within budget; the original symptom is gone.
- No orphaned provisioning: check for tenants stuck in `provisioning` —
  `psql "$DATABASE_URL" -c "SELECT id, slug FROM tf_tenants WHERE status='provisioning';"`; a
  re-`provision` on the same slug is idempotent/resumable and finishes them.

## Rollback / abort

- If rollback itself fails, escalate to [`incident-response.md`](./incident-response.md).

## Escalation

- Page `<on-call>` / incident commander; notify `<stakeholders>`.

## Related

- `deploy.md`, `fleet-migration-rollback.md`, `backup-restore.md`, `incident-response.md`.

---

_Last validated: not yet drilled (beta). Owner: TenantForge maintainers._
