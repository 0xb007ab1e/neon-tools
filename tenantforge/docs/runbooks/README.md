# TenantForge Runbooks

Operational procedures for the TenantForge control plane, written so someone other than the author
can execute them under pressure (`@rules/workflow-runbooks.md`). Linked from alerts and the project
[README](../../README.md).

| Runbook                                                   | When                                                                              |
| --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [deploy](./deploy.md)                                     | Release the control-plane service (build once, promote; registry migration).      |
| [rollback](./rollback.md)                                 | Revert a bad control-plane release.                                               |
| [fleet-migration-rollback](./fleet-migration-rollback.md) | Halt / revert a tenant **fleet** schema migration.                                |
| [incident-response](./incident-response.md)               | Security incident or outage (cross-tenant leak / Neon API key compromise = SEV1). |
| [backup-restore](./backup-restore.md)                     | Restore the control-plane registry and/or a tenant's data.                        |
| [on-call](./on-call.md)                                   | Alert → first move; mitigate-first; escalation; handoff.                          |
| [scaling](./scaling.md)                                   | Scale the real constraint (Neon API limits / fleet batch / DB pool).              |
| [secret-rotation](./secret-rotation.md)                   | Rotate the Neon API key, registry creds, HTTP token, per-tenant secrets.          |
| [dependency-patch](./dependency-patch.md)                 | Patch a vulnerable dependency (workspace overrides).                              |
| [game-day](./game-day.md)                                 | Periodic live-Neon drill of these runbooks against a non-prod org.                |

> **Status:** drilled (2026-06-17) — see the [drill report](./drill-report.md). The **live-Neon
> game-day passed** against a non-prod org (10/10: provision→purge lifecycle, fleet migrate+revert,
> queue/worker, registry queries); the registry/queue layers were also exercised against an
> ephemeral Postgres, and one `deploy.md` drift was caught + fixed. **Remaining:** the manual-only
> `NEON_API_KEY` rotation and Neon PITR restore (console ops). Each footer tracks its own state.
