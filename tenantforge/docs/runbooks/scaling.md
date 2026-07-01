# Runbook: Scaling

> Scaling the TenantForge control plane. Rules: `@rules/topic-reliability.md`,
> `@rules/topic-performance.md`.

## When to use

- Sustained high load, latency/error-budget burn, a provisioning surge, a large fleet migration, or
  scaling down to cut cost.

## Prerequisites & access

- Orchestrator/autoscaler access; dashboards. Know the real bottleneck before scaling — for
  TenantForge it is **rarely the web tier**.

## The actual constraints (scale these, not reflexively the web tier)

1. **Neon API rate limits** — provisioning/offboarding bursts hit the Neon API. Symptom: `429`/5xx
   from Neon. Mitigation: throttle provisioning concurrency; back off + retry (the adapter already
   bounds retries); spread bulk onboarding over time. You cannot "scale up" Neon's API — pace into it.
2. **Fleet-migration concurrency** — `migrate-fleet --batch <N>` bounds tenants applied at once.
   Raise `--batch` for throughput, **lower** it if you're overloading Neon or the tenants. It's
   resumable, so a conservative batch that you re-run is safe.
3. **Control-plane DB connection pool** — the registry pool caps concurrent registry ops. If
   exhausted, raise the pool size and/or front it with a pooler (Neon pooled connection string);
   keep transactions short (`@rules/topic-database.md`).
4. **HTTP/web tier** — usually last. Scale replicas only if `/v1` latency burns the budget and the
   above are healthy.

## Steps

1. Confirm the bottleneck from metrics (Neon `429` rate, DB pool saturation, queue/batch lag).
2. Scale/throttle the **specific** constraint above. Respect downstream limits — don't let a big
   fleet migration overwhelm Neon or the registry.
3. For known events (mass onboarding, planned fleet migration), pre-plan pacing.

## Verification

- Latency/error rate back within SLO (`docs/reliability/slos.md`: transition p95 ≤ 1000 ms / S3,
  success rates S1/S2/S5 above target, budget no longer fast-burning); Neon `429`s subside; no new
  downstream bottleneck.

## Load / soak testing (capacity planning)

Two layers, mirroring the game-day split:

1. **Orchestration harness (hermetic — run anytime):** `pnpm --filter tenantforge load` drives the
   real fleet orchestrator over a large synthetic fleet with in-memory fakes, so it measures the
   in-house fan-out (batching, **bounded concurrency**, failure isolation) without touching Neon.
   Knobs: `TF_LOAD_TENANTS` (default 1000), `TF_LOAD_BATCH` (10), `TF_LOAD_APPLY_MS` (simulated
   per-tenant latency, 0), `TF_LOAD_ITERATIONS` (3), `TF_LOAD_FAIL_PCT` (0). It prints throughput +
   peak concurrency per run and **exits non-zero if concurrency ever exceeds the batch bound**.
   Example — model 5k tenants, batch 25, 50 ms/apply, 5% failures:
   ```bash
   TF_LOAD_TENANTS=5000 TF_LOAD_BATCH=25 TF_LOAD_APPLY_MS=50 TF_LOAD_FAIL_PCT=5 \
     pnpm --filter tenantforge load
   ```
   Capacity rule of thumb: throughput ≈ `batch / per-apply-latency` tenants/sec; raising `--batch`
   helps only until Neon's API rate limit or the registry pool is the bottleneck. A CI regression
   guard for the concurrency bound lives in `test/adapters/fleet-orchestrator.test.ts`.
2. **Live-Neon load profile (operator-run, gated — like the game-day):** the real bottleneck is the
   **Neon API rate limit**, which can't be load-tested hermetically and must not be hammered. Against
   a **non-prod** org, provision a batch of tenants and run a `migrate-fleet` at the intended batch
   size, watching Neon `429`s and the adapter's backoff. **Pace into the limit** — do not raise
   `--batch` to force throughput past `429`s. Record the sustainable provisioning rate + fleet
   throughput as the documented SLO (record it in `docs/reliability/slos.md` — this is the
   capacity input behind the S1/S4 targets); re-measure when Neon's limits or the batch defaults change.

## Scaling back down

- Reduce gradually while watching metrics; keep HA minimums; confirm no thrashing.

## Escalation

- If scaling doesn't relieve it (or a hard Neon quota is hit), alert **the maintainer** (ntfy) / open an incident.

## Related

- `on-call.md`, `incident-response.md`, `fleet-migration-rollback.md`.

---

_Last validated: 2026-06-17 — the orchestration load harness (`pnpm load`) runs and proves the
fleet fan-out stays within the batch bound (CI-guarded). The live-Neon load profile is operator-run
(non-prod org). Traced to code in the drill ([drill-report](./drill-report.md)). Owner: TenantForge maintainers._
