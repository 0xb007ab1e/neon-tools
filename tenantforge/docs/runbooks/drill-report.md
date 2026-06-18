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
   lifecycle smoke, and the fleet migrate + revert. See the dedicated section below. The
   **`NEON_API_KEY` rotation** was also drilled (suite re-run 10/10 on the rotated key), and the
   **Neon PITR restore** was drilled with a row-level recovery proof (see below). All gates green.

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

| Runbook                  | Validation                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| deploy                   | Registry `migrate` executed; **drift fixed**; live provision/purge smoke pending (Neon).          |
| rollback                 | Stuck-in-`provisioning` query **executed**; live app rollback is operator/deploy-specific.        |
| fleet-migration-rollback | §2 assessment + failure-list queries **executed**; live revert migration pending (Neon).          |
| backup-restore           | **PITR drilled** (row-level recovery via a point-in-time branch); status query also executed.     |
| secret-rotation          | **NEON_API_KEY + DATABASE_URL rotations drilled** (rotated-key suite re-run; DB-cred dual-valid). |
| on-call                  | Traced; its registry triage queries are the ones executed above.                                  |
| scaling                  | Traced (procedural — Neon `429`/pool/batch guidance; no automatable assertion).                   |
| incident-response        | Traced (procedural — containment-by-vector; SecretStore-vs-registry payoff confirmed).            |
| dependency-patch         | Already exercised for real in the vitest/vite/esbuild remediation.                                |

## Live-Neon game-day — executed 2026-06-17

The automated suite ([`game-day.md`](./game-day.md)) ran against a dedicated **non-prod Neon org**
via `pnpm --filter tenantforge test:int`: **10/10 tests passed, 0 skipped** (~20s) — the full lifecycle
smoke (provision → suspend → resume → offboard → resume → purge), a fleet migration + idempotent
re-run + compensating revert on a canary, the provision round-trip, the Postgres queue/worker, and
the registry assessment queries. All provisioned `gd-*`/canary projects were auto-purged.

- **Also validated in CI:** the `tenantforge-game-day` workflow (manual `workflow_dispatch`, secrets
  in the maintainer-gated `tenantforge-game-day` Environment) ran the same suite **green** against
  the non-prod org — a repeatable, re-runnable proof, not just a one-off local run.
- Observation: a `pg` deprecation warning — `sslmode=require` is currently treated as `verify-full`;
  `pg` v9 will change that. Prefer `sslmode=verify-full` in production DSNs (no action required now).
- Observation: the CI runner flags the pinned actions as Node-20-based (forced onto Node 24); bump
  `actions/checkout` / `actions/setup-node` / `pnpm/action-setup` pins at the next CI touch.

## NEON_API_KEY rotation drill — executed 2026-06-17

A new (rotated) non-prod API key was minted in the Neon org; the full game-day suite was re-run with
it — **10/10 passed** — confirming provisioning/lifecycle/fleet work on the rotated key (the
`secret-rotation.md` verification step). Revoking the old key is the operator's console step after
verification.

## DATABASE_URL registry-credential rotation drill — executed 2026-06-18

The `secret-rotation.md` **DATABASE_URL** procedure (zero-downtime, add-new-before-revoke-old) was
drilled against the **non-prod** control-plane registry — non-destructively, without touching the
primary credential. Run via SQL through the owner role (no Neon console needed for the drill):

1. **Add new** — minted a throwaway least-privilege role (`tf_rotate_drill_*`, random password) with
   `CONNECT` + `USAGE` + DML on the `tf_*` tables — the "new credential."
2. **Verify dual-valid** — both the **old** (primary) and the **new** credential authenticated and
   read the registry (`tf_tenants`) concurrently → the dual-valid window is real (the runbook's
   "verify `/health` + a registry read" step).
3. **Reject revoked** — a deliberately wrong password was rejected (`password authentication
failed`); after **revoke + `DROP ROLE`**, the new credential could no longer connect → revocation
   is complete and fails closed.
4. **No disruption** — the primary credential still worked throughout; post-drill there were **no
   residual `tf_rotate_drill_*` roles** and `tf_tenants` was unchanged (0 rows).

Result: **PASS.** Rotating the real `DATABASE_URL` in production is the same flow — mint/rotate the
role via Neon, roll the new DSN to instances, verify, then revoke the old (the Neon-side credential
change is the operator's console/API step; the mechanics above are what it exercises).

## PITR row-level recovery drill — executed 2026-06-18

Strong proof of registry recoverability: a canary row (`pitr-canary`, `active`) was inserted into the
**primary** registry, a **point-in-time branch** was created from the primary at the current head, and
the branch was queried — the canary was present (`active 1`, same id), confirming a real row that
existed at time T is recovered via PITR. The marker was then deleted from the primary (registry back
to 0) and the temp connection string shredded. The revert paths (delete the branch / restore from the
auto-created `<branch>_old_<ts>` backup) are documented in `backup-restore.md`.

## Residual work (all `stable` gates drilled)

- **Accepted Low residuals** (not blockers — tracked in `docs/security/threat-model.md`): the deferred
  alternate adapters (other queue brokers / secret stores / exporters), each in its own branch.
  _(Now resolved: per-operator OIDC ships behind the `Authenticator` port; the multi-instance
  rate-limit store ships as a Postgres-backed `RateLimitStore`; and both the `NEON_API_KEY` and
  `DATABASE_URL` rotations are drilled.)_
- Re-drill the automated suite after any change to the CLI surface, registry schema, or HTTP contract.

---

_Owner: TenantForge maintainers. Re-run the registry/queue drill with `pnpm test:int` against an
ephemeral Postgres; re-run the live-Neon path with a non-prod org's credentials._
