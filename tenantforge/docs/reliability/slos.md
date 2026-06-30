# TenantForge — Service Level Objectives (SLOs)

> Closes gap #5 (2026-06-30 gap analysis): the runbooks referenced "SLO" / "error budget"
> without any document defining the numbers. This is that document. Rules:
> `@rules/topic-reliability.md` (SLIs/SLOs/error budgets), `@rules/topic-logging-observability.md`
> (telemetry). Pairs with `docs/runbooks/{deploy,rollback,scaling}.md`.

## Status of these targets

The targets below are an **initial engineering proposal**, not yet ratified with stakeholders.
TenantForge is an **operator/customer control-plane** (provisioning + lifecycle orchestration over
the Neon API), **not** a high-traffic public data path — so the targets are set for a low-volume,
correctness-critical service whose availability is partly bounded by an external upstream (Neon).
Treat them as the baseline to operate against and revise; **review quarterly** and after any
incident. Where an SLI is not yet measurable from emitted telemetry, it is listed under
[Measurement gaps](#measurement-gaps) rather than given a number we cannot compute.

## How SLIs are measured (telemetry source of truth)

All SLIs below are derived from the control-plane **event stream** — the same `TenantEvent`s that
feed structured logs feed the Prometheus metrics (`src/core/observability.ts`,
`src/adapters/metrics-event-sink.ts`), served at `GET /metrics`:

- `tenantforge_events_total{event,outcome}` — counter; `outcome` is `ok` | `error`. Drives **success
  rate** (request rate + error rate, the R+E of RED).
- `tenantforge_event_duration_ms{event}` — histogram of operation durations. Drives **latency**
  (the D of RED). **Bucket boundaries (ms): 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, +Inf.**

> **Per-instance caveat (gap #12):** the sink accumulates in-process, so `/metrics` reflects one
> replica. Prometheus must scrape **every** replica and aggregate; counters reset on restart/redeploy.
> Compute SLIs over the aggregated fleet series, not a single pod.

A success-rate SLI is `sum(ok) / sum(ok+error)` for the relevant `event`(s) over the window. A
latency SLI is a quantile over the `_bucket` series (so it inherits the bucket resolution above — see
the provisioning-latency gap).

## SLO catalog (measurable today)

Window: **28-day rolling** unless noted. Error budget = `(1 − SLO) × valid events in window`.

| #   | SLI                                                                                                              | Event series                                              | SLO target                                                           | 28d error budget    |
| --- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------- | ------------------- |
| S1  | **Provisioning success rate**                                                                                    | `tenant.provisioned` ok ratio                             | **≥ 99.0%**                                                          | 1.0% of provisions  |
| S2  | **Lifecycle-operation success rate** (suspend/resume/offboard/restore/rehome)                                    | `tenant.transition` ok ratio                              | **≥ 99.5%**                                                          | 0.5% of transitions |
| S3  | **Lifecycle-operation latency**                                                                                  | p95 `tenant_event_duration_ms{event="tenant.transition"}` | **p95 ≤ 1000 ms**                                                    | n/a (latency SLO)   |
| S4  | **Fleet-migration per-tenant success**                                                                           | `fleet.migration` ok ratio, **per migration run**         | **≥ 99.0%** per run                                                  | 1.0% of tenants/run |
| S5  | **Billing-run success rate**                                                                                     | `billing.run` ok ratio                                    | **≥ 99.5%**                                                          | 0.5% of runs        |
| S6  | **Background-sweep success + liveness** (quota / usage-alert / secret-rotation / snapshot-prune / erasure-sweep) | `tenant.*_sweep` + `tenant.erased`/`archived` ok ratio    | **≥ 99.0%** ok **AND** each scheduled sweep runs within its interval | 1.0%                |

Notes:

- **S1** is intentionally only 99.0%: provisioning calls the Neon API (an untrusted upstream with its
  own availability + `429`s); the adapter already does bounded retry + transient classification
  (`src/adapters/neon-api/provisioning-provider.ts`), but some failures are genuinely upstream and
  outside our budget to eliminate. Track the Neon dependency separately (gap M2).
- **S4** is _per migration run_, not 28-day: a fleet migration is a release (`@rules/workflow-release.md`).
  The design invariant — a failure in one tenant never blocks the others — is verified in tests; this
  SLO bounds how many tenants in a single run may fail before the run is rolled back
  (`docs/runbooks/fleet-migration-rollback.md`).
- **S6** includes a **liveness** clause: a sweep that **did not run** is an incident too
  (`@rules/templates/batch-job.md`) — alert on silent non-execution, not only on `error` outcomes.

## Error-budget policy

The error budget gates feature velocity vs. hardening (`@rules/topic-reliability.md`):

- **Budget healthy (> 25% remaining):** ship normally.
- **Budget low (≤ 25% remaining):** prioritize reliability work; risky changes (fleet migrations,
  provisioning-path changes) require extra review + a canary.
- **Budget exhausted (SLO breached over the window):** **freeze** non-essential changes to the
  affected path until the budget recovers; only reliability fixes + rollbacks ship. Record the
  decision (`@rules/workflow-release.md`).

Any deliberate budget spend (e.g. a risky migration) is owned and time-boxed — no permanent waivers.

## Burn-rate alerting

Alert on **error-budget burn rate**, not raw error count (`@rules/topic-logging-observability.md`),
using multi-window burn rates (Google SRE) scaled to each SLO's budget:

- **Fast burn → page:** ≥ **2%** of the 28-day budget consumed in **1 h** _and_ ≥ 5% in 6 h.
- **Slow burn → ticket:** ≥ **10%** of the budget consumed in **3 days**.
- **Liveness → page:** a scheduled sweep (S6) has not emitted within its interval + grace.
- **Readiness:** `GET /ready` returning 503 (dependency degraded) is a separate availability signal
  feeding the same on-call path (`src/app/http-server.ts`).

Route alerts to on-call with the breached SLO + correlation id as context
(`docs/runbooks/on-call.md`, `docs/runbooks/incident-response.md`).

## Measurement gaps (SLIs we cannot compute yet)

These are **not** assigned SLO numbers because the telemetry to measure them does not exist yet;
each is a tracked follow-up so an SLO isn't asserted on a series we can't compute.

- **M1 — HTTP request availability/latency.** There is **no per-request HTTP metric** today (the
  metrics are operation-event level, not request level). A control-plane API availability SLI
  (`5xx` ratio) and `/v1` request-latency p95/p99 need an HTTP middleware that emits a request
  counter + duration histogram by route + status class. Until then, S1/S2 success rates + `/ready`
  are the interim availability proxy. **(Highest-value gap to close to make this doc complete.)**
- **M2 — Neon upstream SLI.** Neon-API `429`/error rate is not a distinct series (it's folded into
  S1's outcome). Add a `neon.api` call counter + duration to track the dependency directly
  (`@rules/topic-api-consumption.md`); the runbooks reference "Neon 429 rate" as a watch signal.
- **M3 — Provisioning latency.** `tenant.provisioned` duration regularly exceeds the **5000 ms** top
  bucket (Neon project creation takes tens of seconds), so a p95 latency SLO on it is not meaningful
  with the current buckets. Extend `DURATION_BUCKETS_MS` for the provisioning event (e.g. add 10s,
  30s, 60s) before setting S1's latency counterpart.
- **M4 — Connection-resolution denial rate.** The deploy runbook lists "connection-resolution
  denials" as a watch signal, but routing does not emit a dedicated `connection.*` event/denial
  counter today. Add one to make it an SLI.
- **M5 — Fleet metric aggregation (gap #12).** Per-instance counters must be aggregated across
  replicas (or labelled per `instance`) for any fleet-wide SLI to be accurate.

## References

- `@rules/topic-reliability.md` (SLI/SLO/error-budget); Google SRE / SRE Workbook (multi-window
  burn-rate alerting); `@rules/topic-logging-observability.md` (RED metrics, telemetry).
- Runbooks that consume these targets: `docs/runbooks/deploy.md`, `rollback.md`, `scaling.md`.

---

_Last reviewed: 2026-06-30 (initial proposal — ratify targets with stakeholders). Owner: TenantForge maintainers._
