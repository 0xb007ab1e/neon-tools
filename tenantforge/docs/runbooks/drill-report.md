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

3. **Executed live — the automated Neon path (2026-06-17).** With a non-prod org's credentials the
   full integration suite ran against real Neon (10/10 passed) — provision/delete projects, the
   lifecycle smoke, and the fleet migrate + revert. See the dedicated section below. The two
   **manual-only console** steps (real `NEON_API_KEY` rotation, Neon PITR/branch restore) remain
   to be drilled by hand.

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

## Live-Neon game-day — executed 2026-06-17

The automated suite ([`game-day.md`](./game-day.md)) ran against a dedicated **non-prod Neon org**
via `pnpm --filter tenantforge test:int`: **10/10 tests passed, 0 skipped** (~20s) — the full lifecycle
smoke (provision → suspend → resume → offboard → resume → purge), a fleet migration + idempotent
re-run + compensating revert on a canary, the provision round-trip, the Postgres queue/worker, and
the registry assessment queries. All provisioned `gd-*`/canary projects were auto-purged.

- Observation: a `pg` deprecation warning — `sslmode=require` is currently treated as `verify-full`;
  `pg` v9 will change that. Prefer `sslmode=verify-full` in production DSNs (no action required now).

## Residual work

- **Manual-only steps not yet drilled:** the **NEON_API_KEY / registry-credential rotation** and the
  **Neon PITR / branch restore** (both console operations) — see `secret-rotation.md` /
  `backup-restore.md`. Run them by hand against a non-prod org to fully close R4.
- Re-drill the automated suite after any change to the CLI surface, registry schema, or HTTP contract.

---

_Owner: TenantForge maintainers. Re-run the registry/queue drill with `pnpm test:int` against an
ephemeral Postgres; re-run the live-Neon path with a non-prod org's credentials._
