# Runbook: Scheduled Billing Run

> Operational procedure for the recurring billing run (charge the fleet, then dun failures).
> Rules: `@rules/workflow-runbooks.md`, `@rules/templates/batch-job.md`,
> `@rules/topic-reliability.md`.

## When to use

- The **scheduled** monthly/period billing run (normally a cron / K8s CronJob calling the CLI).
- A **manual catch-up** run after an incident, a deploy that paused the scheduler, or a missed cycle.
- NOT for a single tenant — use `charge <id>` for that.

## Severity / impact

- Routine when scheduled. A failed or skipped run delays revenue and can let a past-due tenant slip
  its dunning clock — treat a **failed** run (non-zero exit) as an alertable SEV3, and a run that
  **didn't fire at all** as an incident too (a silent non-execution is the dangerous case).

## Prerequisites & access

- A configured payment gateway: `TENANTFORGE_PAYMENT_GATEWAY=stripe` + `STRIPE_SECRET_KEY`
  (the run fails closed without it). The audit store (`TENANTFORGE_AUDIT_LOG=pg`) should be on so
  dunning has failure history and the run is recorded.
- CLI access with the billing env (the run **moves real money** and may **suspend** tenants — it is
  `--yes` gated). Least-privilege Neon API key + registry credential from the secret manager.

## Steps

1. **Dry-confirm scope** (read-only): check recent runs and outstanding failures first.
   - `tenantforge cli billing-run --help` → confirm flags.
   - Review `GET /v1/billing/runs` and `/v1/billing/dunning` (or the dashboard billing panel) → no
     surprise backlog of failures.
2. **Run it** (gated). Defaults to the current calendar month; override with `--from`/`--to`.
   - `tenantforge cli billing-run --yes` → prints
     `billing run …  charge: N charged, S skipped, F failed` + `dunning: R retried, X suspended, …`.
   - Charge-only (skip dunning): add `--skip-dunning`.
   - Tune dunning policy: `--max-attempts 4 --min-hours 24`.
   - Machine-readable: add `--json` (pipe to your log/metrics sink).
3. **Cron wiring** (one-time): schedule the same command (e.g. K8s CronJob, daily or per billing
   cycle). The run is **idempotent** — charges de-duplicate on a stable per-period idempotency key
   and dunning re-derives state from the audit trail, so a scheduler double-fire is safe; no lock
   needed. Set `concurrencyPolicy: Forbid` anyway to avoid wasted overlapping work.

## Verification

- Exit code `0` and a new `billing.run` event in `GET /v1/billing/runs` (or the dashboard).
- `charge.failed` and `dunning.failed` are empty (non-zero exit means at least one tenant failed —
  see Rollback/abort). Suspended tenants in the run are expected only for retry-exhausted accounts.
- Spot-check a charged tenant's `tenant.charged` event (amount/status, no card data).

## Rollback / abort

- **A run cannot be "undone"** — successful charges are real. To reverse a wrongful charge, issue a
  refund with **`tenantforge cli refund <chargeId> --yes`** (full, or `--amount <minor>` for a
  partial); it derives the currency/tenant from the charge's audit event and records a
  `tenant.refunded` event. The chargeId is in `GET /v1/billing/charges` / the dashboard.
- **Partial failures are isolated** — a decline/error on one tenant never blocks others; re-running
  is safe (idempotent) and only re-attempts the unfinished work. Investigate persistent
  `dunning.failed` tenants individually (`charge <id>` with the same period to see the live error).
- If a run **suspended** a tenant in error (e.g. a transient PSP outage looked like repeated
  declines), `resume <id>` after the cause is fixed; the next run re-evaluates from the audit trail.

## Escalation

- Page `<on-call>` on a failed run that doesn't clear on a retry, or any cross-tenant anomaly;
  follow `incident-response.md` for a suspected mass-charge or PSP-credential issue.

## Related

- `deploy.md` (the run ships with the service), `secret-rotation.md` (the `STRIPE_SECRET_KEY`),
  `incident-response.md`; rules `@rules/topic-reliability.md`, `@rules/std-owasp-llm.md` (LLM08 —
  why the run is CLI-gated and off the agent surface).

---

_Last validated: 2026-06-21 (authored with the feature; drill at the next game-day). Owner: TenantForge maintainer._
