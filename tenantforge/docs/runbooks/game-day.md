# Runbook: Live-Neon Game-Day

> The periodic drill that validates the runbooks against **real Neon** — the part the registry/queue
> drill ([drill-report](./drill-report.md)) could not cover. Provisions and purges throwaway tenants
> against a **non-prod** org. Rules: `@rules/workflow-runbooks.md`, `@rules/workflow-release.md`.

## When to use

- Before relying on the runbooks in a real incident; on a cadence (e.g. quarterly); and after any
  change to the CLI surface, the registry schema, or the HTTP contract.

## Severity / impact

- Routine, non-prod. It **provisions and deletes real Neon projects** (cost ≈ \$0 with scale-to-zero +
  purge), so it must run **only** against a dedicated non-prod org — never prod, never with prod data.

## Prerequisites & access

- A **dedicated non-prod Neon org** and a throwaway control-plane registry Postgres (`DATABASE_URL`)
  in that org. **Never point this at prod.**
- A **least-privilege `NEON_API_KEY`** scoped to the non-prod org, plus `NEON_ORG_ID`.
- Provisioning real cloud resources is a **gated action** (`@rules/workflow-gated-actions.md`) — a
  human runs this deliberately; it never runs on push/PR.

## Setup (one-time)

Do this once to enable the drill; reuse it every run. **Use a throwaway non-prod org — never prod.**

1. **Create a dedicated non-prod Neon org** (or a clearly-named sandbox org). This org is where the
   drill provisions and deletes throwaway tenant projects, so isolate it from anything real.
2. **Create the control-plane registry project** in that org — a Neon project whose Postgres holds
   the tenant **metadata** (the `tf_*` tables). Copy its pooled connection string → this is
   `DATABASE_URL`. (The drill runs `migrate` to create the schema; start from an empty DB.)
3. **Find the org id**: `NEON_ORG_ID` is the org's id (Neon console → org settings, or
   `GET /users/me/organizations` via the API). The account is org-scoped, so it's required.
4. **Mint a least-privilege API key scoped to the non-prod org** (Neon console → API keys → an
   **organization** key for that org, not a personal key with broader reach) → this is
   `NEON_API_KEY`. Treat it as a secret; never commit it (`@rules/workflow-secrets.md`).
5. **Wire the credentials** for whichever run mode you'll use:
   - **CI:** repo → _Settings → Environments → New environment_ named **`tenantforge-game-day`**.
     Restrict its deployment branches and add **required reviewers** (maintainers) so only a
     deliberate, approved dispatch can use the secrets. Add three **environment secrets**:
     `DATABASE_URL`, `NEON_API_KEY`, `NEON_ORG_ID`. (The workflow's preflight fails if any is unset.)
   - **Local:** export the same three vars in your shell (or a git-ignored `.env`), never committed.
6. **Verify** without provisioning anything: `tenantforge migrate` against the non-prod `DATABASE_URL`
   should print `migrations applied`. You're ready — proceed to the drill below.

> Cost: throwaway projects scale to zero and the drill purges them, so a run is ≈ \$0. After a run,
> confirm no `gd-*` projects linger in the org (see Rollback / abort).

## Steps

### 1. Automated drill (covers most of it)

Two ways to run the integration suite, which self-skips without credentials:

- **CI (preferred):** trigger the **TenantForge Game-Day (live Neon)** workflow
  (`.github/workflows/tenantforge-game-day.yml`) via _Run workflow_ → type `run` to confirm. It runs
  in the `tenantforge-game-day` Environment (maintainer-restricted; holds the three secrets) and
  fails preflight if any secret is missing (so it can't report a misleading green).
- **Locally:**
  ```bash
  export DATABASE_URL=...   # non-prod control-plane registry
  export NEON_API_KEY=...   # non-prod org, least privilege
  export NEON_ORG_ID=...
  pnpm --filter tenantforge test:int
  ```

Expected: all integration tests **pass** (none skipped). What each validates:

| Integration test        | Runbook(s) drilled                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `provision.int.test.ts` | `deploy.md` (provision round-trip + idempotency + teardown).                                                                |
| `lifecycle.int.test.ts` | `deploy.md` smoke (provision→purge), `backup-restore.md` ("resume = restore"), suspend/resume/offboard/purge state machine. |
| `fleet.int.test.ts`     | `fleet-migration-rollback.md` (apply across fleet → idempotent re-run → compensating revert).                               |
| `queue.int.test.ts`     | the lifecycle **worker** path (Postgres broker: claim/visibility/ack, redelivery, DLQ).                                     |
| `drill.int.test.ts`     | the `psql` assessment queries in `rollback.md` / `backup-restore.md` / `fleet-migration-rollback.md`.                       |

### 2. Manual-only steps (no safe automation — do these by hand against the non-prod org)

- **`NEON_API_KEY` rotation** (`secret-rotation.md`): in the Neon org, create a **new** key → update
  the Environment secret / local env → re-run step 1 (proves provisioning works on the new key) →
  **revoke** the old key. Confirms the rotation procedure end to end.
- **Neon PITR registry restore** (`backup-restore.md`): in the Neon console, restore the control-plane
  project to a **new branch** → point a verification `DATABASE_URL` at it → run
  `psql "$DATABASE_URL" -c "SELECT status, count(*) FROM tf_tenants GROUP BY status;"` and confirm it
  matches expectations → only then cut over. Record actual RTO.

## Verification

- Step 1 is all-green with **0 skipped**; no orphaned projects remain in the non-prod org (check the
  Neon console — the tests purge/delete what they create).
- Step 2 procedures completed without surprises; any drift found is fixed in the runbook + recorded.

## After a clean run

- Stamp the run date into each drilled runbook's `_Last validated_` footer and into
  [`drill-report.md`](./drill-report.md) (move the relevant items out of "residual"). An undated
  pass doesn't count.
- File any drift found as a fix PR (a runbook that didn't match reality is a defect).

## Rollback / abort

- The drill is self-cleaning (it purges what it provisions). If a run is interrupted, check the
  non-prod org for leftover `gd-*` projects and delete them; clear leftover `gd-*` / `drill_*` rows
  from the registry.

## Escalation

- If the game-day fails against non-prod, **do not** deploy — fix the cause first. A failure here is a
  caught defect, not an incident.

## Related

- [`drill-report.md`](./drill-report.md), `deploy.md`, `fleet-migration-rollback.md`,
  `backup-restore.md`, `secret-rotation.md`; `@rules/workflow-runbooks.md`.

---

_Last validated: 2026-06-17 — **automated suite executed live against a non-prod Neon org: 10/10
passed, 0 skipped** (provision→purge lifecycle, fleet migrate + revert, queue/worker, registry
assessment queries). The two manual-only steps (NEON_API_KEY rotation, Neon PITR restore) remain to
be drilled. Owner: TenantForge maintainers._
