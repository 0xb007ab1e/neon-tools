# Runbook: Deploy (Control-Plane Service)

> Releasing the TenantForge **control-plane service** itself. Deploying a tenant **fleet** schema
> change is a separate release — see [`fleet-migration-rollback.md`](./fleet-migration-rollback.md)
> and the `migrate-fleet` CLI. Rules: `@rules/workflow-release.md`.

## When to use

- Promoting a tagged, gate-passing build of the control plane (staging → prod).

## Prerequisites & access

- Green CI on the release commit (lint, typecheck, tests/coverage, audit, secret-scan, CodeQL);
  signed artifact. Deploy role (least privilege, OIDC).
- Target env secret store has `DATABASE_URL` (control-plane registry), `NEON_API_KEY`, `NEON_ORG_ID`,
  and `TENANTFORGE_HTTP_TOKEN` (if serving HTTP). **The in-memory secret store is dev-only** — prod
  must inject a persistent `SecretStore` (see `secret-rotation.md`).

## Steps

1. Confirm the release tag + artifact digest match the intended commit.
2. Apply **control-plane registry** migrations (this migrates the tenant _registry_ DB, NOT tenant
   DBs): `tenantforge migrate` → expected `migrations applied`. Changes are backward-compatible
   (expand/contract — `@rules/topic-database.md`); no long locks.
3. Deploy the **promoted artifact** (build once, promote — no per-env rebuild).
4. Roll out progressively (canary/blue-green); watch SLOs for `<N>` min against the targets in
   `docs/reliability/slos.md`: provisioning success **≥ 99.0%** (S1), lifecycle-transition success
   **≥ 99.5%** / p95 **≤ 1000 ms** (S2/S3), Neon API error/`429` rate (M2 watch signal),
   connection-resolution denials (M4). Halt the rollout on a fast-burn alert (≥ 2% of the 28-day
   budget in 1 h).
5. Flip feature flags as planned (default off/safe).

## Verification

- `GET /health` green. Smoke test in a **non-prod org**: `tenantforge provision smoke-$(date +%s)`
  → `active` + a project id (note the printed tenant id). Tear the smoke tenant down with
  `tenantforge offboard <id>` (archives it) then `tenantforge purge <id> --yes` (irreversible delete —
  leaves no canary behind). Error rate within budget.

## Rollback / abort

- Control-plane regression → [`rollback.md`](./rollback.md). Tenant fleet-migration regression →
  [`fleet-migration-rollback.md`](./fleet-migration-rollback.md).

## Escalation

- Page `<on-call>`; notify `<stakeholders>` on `<channel>`.

## Related

- `rollback.md`, `scaling.md`, `secret-rotation.md`; `@rules/workflow-release.md`.

---

_Last validated: 2026-06-17 — **live-Neon game-day passed** against a non-prod org: the provision → purge smoke ran end-to-end (registry `migrate`, provision, teardown). The deploy-smoke drift was caught + fixed earlier. See [drill-report](./drill-report.md). Owner: TenantForge maintainers._
