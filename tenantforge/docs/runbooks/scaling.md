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

- Latency/error rate back within SLO; Neon `429`s subside; no new downstream bottleneck.

## Scaling back down

- Reduce gradually while watching metrics; keep HA minimums; confirm no thrashing.

## Escalation

- If scaling doesn't relieve it (or a hard Neon quota is hit), page `<on-call>` / open an incident.

## Related

- `on-call.md`, `incident-response.md`, `fleet-migration-rollback.md`.

---

_Last validated: 2026-06-17 — procedural; traced to code in the drill ([drill-report](./drill-report.md)). Owner: TenantForge maintainers._
