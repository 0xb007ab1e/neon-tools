# Runbook Drill Report — 2026-06-17

First game-day pass over the TenantForge runbooks (`@rules/workflow-runbooks.md`: "an untested
runbook is a hypothesis"). This records what was validated, how, what was found, and what still
needs a live-Neon drill before the runbooks are fully trustworthy in an incident.

## Method

Three layers of validation, strongest first:

1. **Executed — registry & queue layers (automated).** An ephemeral Postgres
   (`postgres:16-alpine`, throwaway container) stood in for the control-plane registry, and the
   integration suite ran the runbooks' documented assessment queries and the queue/worker path
   against it:
   - `test/integration/drill.int.test.ts` (**new**) — runs each runbook's `psql` assessment query
     verbatim against the real schema: the backup-restore status breakdown, the rollback
     stuck-in-`provisioning` query, and the fleet-migration-rollback §2 per-migration status counts
     plus failure list. **4/4 passed.**
   - `test/integration/queue.int.test.ts` — the Postgres broker + consumer used by the lifecycle
     **worker**: enqueue → claim (visibility timeout) → ack, redelivery after timeout, drain with
     dedupe + dead-letter. **3/3 passed.**
   - These self-skip without `DATABASE_URL`; here they were run against the ephemeral DB
     (`pnpm test:int` → 7 passed, 1 skipped).

2. **Traced — every command/query against the code (tabletop).** Each runbook's CLI invocations,
   HTTP routes, registry columns, and library symbols were checked against the actual source
   (`src/app/cli.ts`, `src/app/http-server.ts`, `migrations/`, `src/ports/`, `src/app/lib.ts`).
   Findings below.

3. **Pending — the live-Neon path.** Steps that provision/delete real Neon projects, rotate the
   real `NEON_API_KEY`, or do Neon PITR/branch restore were **not** executed here (no live Neon
   credentials in this environment, and provisioning real cloud resources is a gated action). The
   `provision.int.test.ts` round-trip (provision → get → idempotent re-provision → teardown) is the
   automated form of that drill and runs when an operator supplies `NEON_API_KEY` + `NEON_ORG_ID`.

## Finding (fixed in this pass)

- **`deploy.md` smoke test cited flags that do not exist.** It said
  `offboard … --yes --skip-export --reason smoke`, but the `offboard` CLI command takes only a
  tenant `id`. Corrected to the real teardown: `offboard <id>` (archive) then `purge <id> --yes`
  (irreversible delete — leaves no canary behind). This is exactly the kind of drift a drill exists
  to catch.

All other referenced commands, flags, HTTP routes (`/health`, `/v1/*`), registry columns
(`tf_tenants`, `tf_migrations`, `tf_tenant_migrations`), statuses, and library symbols
(`SecretStore.set/get`, `getConnection`) were verified accurate against the code.

## Per-runbook status

| Runbook                  | Validation                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| deploy                   | Registry `migrate` executed; **drift fixed**; live provision/purge smoke pending (Neon).   |
| rollback                 | Stuck-in-`provisioning` query **executed**; live app rollback is operator/deploy-specific. |
| fleet-migration-rollback | §2 assessment + failure-list queries **executed**; live revert migration pending (Neon).   |
| backup-restore           | Registry status query **executed**; Neon PITR/branch restore pending (Neon).               |
| secret-rotation          | Traced (`SecretStore.set/get`, `/health`); live key/cred rotation pending (Neon org).      |
| on-call                  | Traced; its registry triage queries are the ones executed above.                           |
| scaling                  | Traced (procedural — Neon `429`/pool/batch guidance; no automatable assertion).            |
| incident-response        | Traced (procedural — containment-by-vector; SecretStore-vs-registry payoff confirmed).     |
| dependency-patch         | Already exercised for real in the vitest/vite/esbuild remediation.                         |

## Residual work (to fully retire "not yet drilled")

- A **live-Neon game-day** with a non-prod org: run the deploy smoke (`provision` → `offboard` →
  `purge --yes`), a real fleet `migrate-fleet` + compensating revert, a `NEON_API_KEY` rotation
  canary, and a Neon PITR registry restore. Gated (real cloud resources/secrets) — run by an
  operator with credentials, then stamp the live date into each footer.
- Re-drill after any change to the CLI surface, registry schema, or HTTP contract.

---

_Owner: TenantForge maintainers. Re-run the registry/queue drill with `pnpm test:int` against an
ephemeral Postgres; re-run the live-Neon path with a non-prod org's credentials._
