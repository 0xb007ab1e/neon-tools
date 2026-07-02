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
  (the D of RED). **Bucket boundaries (ms): 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
  30000, 60000, +Inf.** (The 10s/30s/60s buckets were added for M3 so slow, Neon-bound operations —
  notably `tenant.provisioned` — have a measurable p95 instead of collapsing into `+Inf`.)
- `tenantforge_http_requests_total{method,route,status_class}` — **per-request** counter
  (`status_class` ∈ `2xx|3xx|4xx|5xx`; `route` is the matched **route template**, e.g.
  `/v1/tenants/:id`, never a raw id-bearing path). Drives **API availability** (the R+E of RED at the
  HTTP edge). Emitted by an early timing middleware that times **every** request — including
  `/health`, `/v1`, `/webhooks` — and records a `5xx` even when a handler throws.
- `tenantforge_http_request_duration_ms{method,route}` — **per-request** latency histogram (same
  bucket boundaries as above). Drives **read-path latency**.

> **Per-instance / multi-replica (gap #12 — this is normal Prometheus, not a footgun):** each sink
> accumulates in-process, so `/metrics` reflects one replica. Prometheus already adds an `instance`
> label per scraped target, so the **correct** aggregation is `sum without(instance)(…)` (or
> `sum without(instance)(rate(…[5m]))` for the counters). Counter **resets** on restart/redeploy are
> handled by `rate()`/`increase()`. Do **not** add a home-grown `instance` label. The real
> multi-replica footgun is elsewhere: the in-memory rate-limit / idempotency **stores** — see the
> in-memory-store warning in M5.

> **Endpoint exposure (gap #17):** `GET /metrics`, `/health`, and `/ready` **MUST NOT be publicly
> routable** — scope them to the metrics/admin network (network isolation is the primary control).
> `/metrics` may optionally require a Bearer token (`TENANTFORGE_METRICS_TOKEN`) as defense-in-depth,
> but that token is a supplement to network isolation, never a substitute for it.

A success-rate SLI is `sum(ok) / sum(ok+error)` for the relevant `event`(s) over the window. A
latency SLI is a quantile over the `_bucket` series (so it inherits the bucket resolution above — see
the provisioning-latency gap).

## SLO catalog (measurable today)

Window: **28-day rolling** unless noted. Error budget = `(1 − SLO) × valid events in window`.

| #   | SLI                                                                                                              | Event series                                                   | SLO target                                                           | 28d error budget    |
| --- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------- |
| S1  | **Provisioning success rate**                                                                                    | `tenant.provisioned` ok ratio                                  | **≥ 99.0%**                                                          | 1.0% of provisions  |
| S2  | **Lifecycle-operation success rate** (suspend/resume/offboard/restore/rehome)                                    | `tenant.transition` ok ratio                                   | **≥ 99.5%**                                                          | 0.5% of transitions |
| S3  | **Lifecycle-operation latency**                                                                                  | p95 `tenantforge_event_duration_ms{event="tenant.transition"}` | **p95 ≤ 1000 ms**                                                    | n/a (latency SLO)   |
| S4  | **Fleet-migration per-tenant success**                                                                           | `fleet.migration` ok ratio, **per migration run**              | **≥ 99.0%** per run                                                  | 1.0% of tenants/run |
| S5  | **Billing-run success rate**                                                                                     | `billing.run` ok ratio                                         | **≥ 99.5%**                                                          | 0.5% of runs        |
| S6  | **Background-sweep success + liveness** (quota / usage-alert / secret-rotation / snapshot-prune / erasure-sweep) | `tenant.*_sweep` + `tenant.erased`/`archived` ok ratio         | **≥ 99.0%** ok **AND** each scheduled sweep runs within its interval | 1.0%                |
| S7  | **API availability** (control-plane HTTP edge — non-`5xx` ratio on `/v1`)                                        | `tenantforge_http_requests_total{route=~"/v1.*"}`              | **≥ 99.9%**                                                          | 0.1% of `/v1` reqs  |
| S8  | **Read-path latency** (GET `/v1/*` reads)                                                                        | p95 `tenantforge_http_request_duration_ms` (GET `/v1/*`)       | **p95 ≤ 1000 ms**                                                    | n/a (latency SLO)   |

Notes:

- **S1** is intentionally only 99.0%: provisioning calls the Neon API (an untrusted upstream with its
  own availability + `429`s); the adapter already does bounded retry + transient classification
  (`src/adapters/neon-api/provisioning-provider.ts`), but some failures are genuinely upstream and
  outside our budget to eliminate. Track the Neon dependency separately via the **D1** indicator
  (from the `neon.api` event series — M2, now closed).
- **S4** is _per migration run_, not 28-day: a fleet migration is a release (`@rules/workflow-release.md`).
  The design invariant — a failure in one tenant never blocks the others — is verified in tests; this
  SLO bounds how many tenants in a single run may fail before the run is rolled back
  (`docs/runbooks/fleet-migration-rollback.md`).
- **S6** includes a **liveness** clause: a sweep that **did not run** is an incident too
  (`@rules/templates/batch-job.md`) — alert on silent non-execution, not only on `error` outcomes.
  **Where each sweep runs (gap #1):** the **erasure** and **evidence-prune** sweeps run automatically
  every worker cycle (`src/app/worker.ts` `runWorkerCycle`); the remaining interval sweeps (quota,
  usage-alert, secret-rotation, snapshot-prune, archived-purge) are **CLI commands** an operator
  schedules via external cron (`tenantforge cli <sweep>`), so their liveness depends on that wiring —
  a missing cron is the silent-non-execution incident this clause covers.
- **S7** is the HTTP-edge availability SLI:
  `sum without(instance)(rate(tenantforge_http_requests_total{status_class!="5xx",route=~"/v1.*"}[5m])) / sum without(instance)(rate(tenantforge_http_requests_total{route=~"/v1.*"}[5m]))`.
  It is **stricter (99.9%)** than the provisioning SLO (S1, 99.0%) because most `/v1` traffic is
  reads served from the control-plane registry — fast, fully within our budget — whereas a `4xx`
  (client error / auth) is **not** counted against availability (only `5xx` is). It is the
  request-level companion to S1/S2 (which stay the source of truth for the Neon-bound write paths).
- **S8** is `histogram_quantile(0.95, sum without(instance)(rate(tenantforge_http_request_duration_ms_bucket{method="GET",route=~"/v1.*"}[5m])) by (le))`.
  It deliberately **excludes the provisioning POST** (`POST /v1/tenants`): project creation is
  Neon-bound and takes tens of seconds, so it is tracked via **S1** (and the **D2** provisioning-latency
  indicator, now that the buckets reach 60 s — M3 closed), not the HTTP read-path latency SLO. Keep S8
  scoped to GET reads.

## Dependency & operational indicators (measurable, not owned SLOs)

These are now emitted from the event stream (M2/M3/M4 closed 2026-06-30). They are **indicators we
watch and alert on**, deliberately framed distinctly from the S-series SLOs above:

| #   | Indicator                              | Event series                                                    | Target / threshold                                                            |
| --- | -------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| D1  | **Neon upstream dependency health**    | `neon.api` ok ratio + duration                                  | **Alerting threshold, not an owned SLO** — see below                          |
| D2  | **Provisioning latency**               | p95 `tenantforge_event_duration_ms{event="tenant.provisioned"}` | **Ratify from observed p95** (target set from data — not yet numbered)        |
| D3  | **Connection-resolution availability** | `connection.resolve` ok ratio                                   | denial-rate watch signal (deploy runbook); ratify a target from observed data |

- **D1 — Neon dependency health (a signal feeding S1, NOT an availability SLO we own).** From
  `tenantforge_events_total{event="neon.api",outcome}` (error rate) and
  `tenantforge_event_duration_ms{event="neon.api"}` (latency), one event per logical Neon call
  (across retries). We **cannot fix Neon's uptime**, so this is not an availability SLO we commit to;
  it is a dependency-health signal that **explains** S1 (provisioning success) and drives an alert
  when the upstream degrades. Error rate:
  `sum without(instance)(rate(tenantforge_events_total{event="neon.api",outcome="error"}[5m])) / sum without(instance)(rate(tenantforge_events_total{event="neon.api"}[5m]))`.
  Latency p95:
  `histogram_quantile(0.95, sum without(instance)(rate(tenantforge_event_duration_ms_bucket{event="neon.api"}[5m])) by (le))`.
  The event `context.status` distinguishes `429` from `5xx`/network for **logs**; per-status-class
  isolation as its own metric label is a documented further refinement (kept out of the label set to
  bound cardinality). **Alerting threshold:** page when the 5m Neon error rate is sustained high
  (e.g. > 10%) — it is a leading indicator for S1 burn.
- **D2 — Provisioning latency.** Now that the duration histogram reaches 60 s (M3),
  `tenant.provisioned` p95 is measurable:
  `histogram_quantile(0.95, sum without(instance)(rate(tenantforge_event_duration_ms_bucket{event="tenant.provisioned"}[5m])) by (le))`.
  **No target number is invented here:** provisioning time is Neon-bound and previously unmeasured —
  the target is **to be ratified from the observed p95** once data accumulates, then promoted to S1's
  latency counterpart.
- **D3 — Connection-resolution availability.** From
  `tenantforge_events_total{event="connection.resolve",outcome}` — `outcome="error"` is a **denial**
  (tenant not found / not routable / no stored secret; the bounded reason is in `context.reason`).
  This makes the deploy runbook's "connection-resolution denials" watch signal real. Denial rate:
  `sum without(instance)(rate(tenantforge_events_total{event="connection.resolve",outcome="error"}[5m])) / sum without(instance)(rate(tenantforge_events_total{event="connection.resolve"}[5m]))`.
  A target is likewise **to be ratified from observed data** (a baseline denial rate is expected from
  legitimate lifecycle states, so a fixed number now would be guesswork).

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

- **M1 — HTTP request availability/latency. ✅ CLOSED (2026-06-30).** The per-request HTTP metrics
  now exist (`tenantforge_http_requests_total{method,route,status_class}` +
  `tenantforge_http_request_duration_ms{method,route}`, emitted by an early timing middleware in
  `src/app/http-server.ts`). They are promoted into the SLO catalog as **S7 (API availability)** and
  **S8 (read-path latency)** above. S1/S2 remain the source of truth for the Neon-bound write paths.
- **M2 — Neon upstream SLI. ✅ CLOSED (2026-06-30).** The Neon provisioning adapter
  (`src/adapters/neon-api/provisioning-provider.ts`) now emits one `neon.api` {@link TenantEvent} per
  logical call (across retries) through the injected event sink, so
  `tenantforge_events_total{event="neon.api",outcome}` (dependency error rate) and
  `tenantforge_event_duration_ms{event="neon.api"}` (dependency latency) render for free. Surfaced as
  the **D1 dependency-health indicator** above — a signal feeding S1 with an alerting threshold, **not**
  an availability SLO we own (we cannot fix Neon's uptime). The event `context` carries a bounded
  `operation` label + `status` (429 vs 5xx/network in logs), never a secret.
- **M3 — Provisioning latency. ✅ CLOSED (2026-06-30).** `DURATION_BUCKETS_MS` now extends to
  **10000, 30000, 60000** ms (backward-compatible; existing buckets unchanged), so `tenant.provisioned`
  p95 no longer collapses into `+Inf`. Surfaced as the **D2 latency indicator** above, with its target
  **to be ratified from observed p95** rather than invented.
- **M4 — Connection-resolution denial rate. ✅ CLOSED (2026-06-30).** The connection router
  (`src/adapters/connection-router.ts`) now emits a `connection.resolve` event per resolve —
  `outcome="error"` marks a denial with a bounded `context.reason`
  (`not_found`/`not_routable`/`no_secret`). `tenantforge_events_total{event="connection.resolve",outcome}`
  gives the denial rate the deploy runbook already watches. Surfaced as the **D3 indicator** above.
- **M5 — Fleet metric aggregation (gap #12) — guidance, not a defect.** Per-instance counters are
  **normal** for Prometheus: it adds an `instance` label per scraped target, so a fleet-wide SLI is
  just `sum without(instance)(rate(…[5m]))` and counter resets on restart/redeploy are handled by
  `rate()`/`increase()`. **Do not** add a home-grown `instance` label to the sink. The genuine
  multi-replica footgun is the in-memory **rate-limit / idempotency stores**: in multi-replica
  production an in-memory rate-limit store can't enforce a **global** limit (each replica counts
  independently) and in-memory idempotency replay-protection is **per-instance** (a POST retry on
  another replica re-executes). These default to `memory` (valid single-replica); `loadConfig` now
  emits a **non-fatal startup warning** when `TENANTFORGE_ENV=production` and either store is
  `memory` (it is a warning, not a fail-closed throw — the process can't know its replica count) —
  set `TENANTFORGE_RATE_LIMIT_STORE=pg` / `TENANTFORGE_IDEMPOTENCY_STORE=pg` for a multi-replica
  deployment.

## References

- `@rules/topic-reliability.md` (SLI/SLO/error-budget); Google SRE / SRE Workbook (multi-window
  burn-rate alerting); `@rules/topic-logging-observability.md` (RED metrics, telemetry).
- Runbooks that consume these targets: `docs/runbooks/deploy.md`, `rollback.md`, `scaling.md`.

---

_Last reviewed: 2026-06-30 (initial proposal — ratify targets with stakeholders). Owner: TenantForge maintainers._
