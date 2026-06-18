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

> **Status:** first drill done (2026-06-17) — see the [drill report](./drill-report.md). The
> registry & queue layers were **executed** against an ephemeral Postgres; all commands/queries
> were traced to code (one `deploy.md` drift caught + fixed). The **live-Neon path** (real
> provision/purge, key rotation, PITR restore) still needs an operator-run game-day — each
> runbook's footer tracks its own validation state.
