# Runbook: On-Call

> Responding to TenantForge control-plane alerts. Rules: `@rules/topic-reliability.md`.

## When to use

- You're on-call and received an alert, or starting/ending a shift.

## Prerequisites & access

- Paging tool, dashboards, log access, the control-plane `DATABASE_URL` (read), and these runbooks.
  Confirm you can deploy/rollback before your shift.

## TenantForge alert → first move

| Alert                                | First move / runbook                                                                                                                                              |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provision failure-rate spike         | Check Neon API status + `429`/5xx; inspect `tf_tenants` stuck in `provisioning`; a re-`provision` is idempotent/resumable.                                        |
| Fleet-migration failures             | `SELECT status,count(*) FROM tf_tenant_migrations …`; see [`fleet-migration-rollback.md`](./fleet-migration-rollback.md).                                         |
| Neon API errors / rate-limit (`429`) | Throttle provisioning, lower fleet `--batch`; see [`scaling.md`](./scaling.md).                                                                                   |
| Connection-resolution denials        | Expected when resolving non-active/unprovisioned tenants (fail-closed). A spike = a routing/auth bug → consider [`incident-response.md`](./incident-response.md). |
| Control-plane DB pool exhaustion     | See [`scaling.md`](./scaling.md) (pool/connection limits).                                                                                                        |
| Suspected cross-tenant access        | Declare — [`incident-response.md`](./incident-response.md). Do not solo a SEV1.                                                                                   |

## Responding

1. **Acknowledge** within the severity window (master §7 — SEV1: right away).
2. **Mitigate first, diagnose later** — throttle/rollback/flag-off to stop user pain, then root-cause.
3. If it's a security incident or major outage, **declare** and follow `incident-response.md`.
4. Keep a timeline; communicate on the incident's **GitHub issue** at a cadence.

## Verification

- Alert cleared; metrics normal; user impact resolved. Snooze only with a follow-up task.

## Escalation

- Solo-maintained: there is **no secondary on-call tier**. If you can't resolve it or it's beyond your
  depth, **pull in outside help** — for a SEV1 security/legal matter engage external security/legal —
  rather than pressing on alone. Escalating early is encouraged.

## Shift handoff

- Document open issues, mitigations in flight, noisy alerts, pending follow-ups.

## Related

- `incident-response.md`, `scaling.md`, `rollback.md`, `fleet-migration-rollback.md`.

---

_Last validated: 2026-06-17 — triage queries executed; rest traced to code in the drill ([drill-report](./drill-report.md)). Owner: TenantForge maintainers._
