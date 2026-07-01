# Runbook: Fleet-Migration Rollback

> Reverting (or recovering from) a schema migration applied across the tenant fleet. A fleet change
> is a **release** (`@rules/workflow-release.md`); this is its rollback path. Pairs with
> `@rules/topic-database.md` (expand/contract) and `@rules/workflow-incident-response.md`.

## When to use

- A `tenantforge migrate-fleet <version> <file.sql>` run **failed on some/all tenants** (the command
  exits non-zero and lists `FAILED <tenantId>` lines), **or**
- The migration applied cleanly but **caused a regression** (errors/latency) once tenants started
  using the new schema.

When NOT to use: a single-tenant issue (handle that tenant directly) or an app-only bug with no
schema change (just roll back the app — see Step 3a).

## Severity / impact

- Partial-failure mid-rollout: usually **SEV2/SEV3** — failures are isolated (other tenants are
  unaffected; the run is resumable), so there is time to decide.
- A bad migration already serving on many tenants: **SEV2+** — follow `runbooks/incident-response.md`
  in parallel.

## Prerequisites & access

- `DATABASE_URL` for the **control-plane registry** (read access is enough to assess).
- `NEON_API_KEY` + `NEON_ORG_ID` and the ability to run `tenantforge migrate-fleet` (it resolves each
  tenant's connection via the secret store + fail-closed router).
- The original migration's `<version>` and SQL file, and — if reverting schema — a **down** SQL file.
- `psql` (or any Postgres client) for the registry queries below.

## Steps

### 1. Stop the bleeding — halt further rollout

The runner applies tenants in **bounded batches and is resumable**, so it only advances when invoked.
**Do not re-run** `migrate-fleet <version>` while you assess. If a run is in progress, interrupt it
(Ctrl-C / kill the process); already-applied tenants are recorded and unaffected, in-flight tenants
roll back their own transaction (per-tenant `BEGIN/COMMIT`).

### 2. Assess per-tenant state (the registry knows exactly)

```bash
# Counts by status for this migration:
psql "$DATABASE_URL" -c "SELECT tm.status, count(*) \
  FROM tf_tenant_migrations tm JOIN tf_migrations m ON m.id = tm.migration_id \
  WHERE m.version = '<version>' GROUP BY tm.status;"
```

Expected: rows like `applied | 42`, `failed | 3`. Then list the failures + reasons:

```bash
psql "$DATABASE_URL" -c "SELECT tm.tenant_id, tm.error \
  FROM tf_tenant_migrations tm JOIN tf_migrations m ON m.id = tm.migration_id \
  WHERE m.version = '<version>' AND tm.status = 'failed';"
```

**Decision point:**

- Failures look transient (timeouts, a slow tenant) and the migration is otherwise correct → **Step 3c** (resume).
- The migration is wrong / causing a regression → **Step 3a or 3b** (roll back).

### 3. Choose the rollback path (prefer the least-destructive)

Fleet migrations are **expand/contract** and backward-compatible, which is what makes rollback safe —
pick the first option that applies:

#### 3a. Roll back the APP only (preferred — no schema change)

If the migration was **additive/expand** (new nullable columns, new tables/indexes the old app
ignores), the previous app version still runs against the new schema. **Roll back the app/deploy**
(`runbooks/rollback.md` in the consuming service) and stop — leave the schema in place. Fastest,
zero fleet-write risk. The unused schema can be removed later in a planned contract migration.

#### 3b. Apply a compensating "down" fleet migration (when schema must be reverted)

A schema revert across the fleet is **itself a fleet migration** — never hand-edit tenant DBs.

1. Author a **new** version (e.g. `<version>_revert`) with **idempotent, backward-compatible** reverse
   SQL (`DROP ... IF EXISTS`, etc.). **Do not drop columns/tables that hold data you need** — that is
   itself destructive; if data is at stake, escalate to `runbooks/incident-response.md` and consider
   `runbooks/backup-restore.md` instead.
2. Apply it across the fleet:
   ```bash
   tenantforge migrate-fleet <version>_revert ./migrations/down/<version>_revert.sql --batch 10
   ```
   → `fleet migration <version>_revert: N applied, 0 failed, ...` It is batched, failure-isolated,
   and resumable exactly like the forward migration. It naturally targets the tenants that have the
   change (re-applying a `DROP ... IF EXISTS` on a tenant that never got the change is a safe no-op).

#### 3c. Resume / retry (failures were transient, migration is correct)

Re-run the **same** command — the planner skips `applied` tenants and retries `failed`/`pending`:

```bash
tenantforge migrate-fleet <version> ./migrations/<version>.sql --batch 5
```

(Lower `--batch` to reduce load if failures were timeouts.) Note: editing the SQL of an
already-registered version is rejected as **checksum drift** — bump to a new version instead.

## Verification

- Registry shows the intended end state for the relevant version:
  ```bash
  psql "$DATABASE_URL" -c "SELECT tm.status, count(*) FROM tf_tenant_migrations tm \
    JOIN tf_migrations m ON m.id = tm.migration_id WHERE m.version = '<version>' GROUP BY tm.status;"
  ```
  → no `failed` rows for the path you took (or the revert version shows all-`applied`).
- The original symptom (errors/latency) is gone; spot-check a previously-failing tenant.
- App health green; no new error classes in logs (`@rules/topic-logging-observability.md`).

## Rollback / abort (of this rollback)

- If a compensating down migration itself starts failing across many tenants, **halt** (Step 1),
  and escalate to `runbooks/incident-response.md` — do not keep hammering the fleet.

## Escalation

- Alert **the maintainer** (ntfy) for SEV2+. Record the timeline + status in the incident's **GitHub issue**.
- Data-loss risk (a destructive down migration, or restore needed) → security/DBA lead +
  `runbooks/backup-restore.md`.

## Related

- `runbooks/incident-response.md`, `runbooks/backup-restore.md`; `@rules/workflow-release.md`,
  `@rules/topic-database.md` (expand/contract), `ARCHITECTURE.md` §5 (fleet migration).

---

_Last validated: 2026-06-17 — **live-Neon game-day passed**: a fleet migration applied across a canary tenant, was idempotent on re-run, and a compensating revert applied — against a non-prod org. §2 assessment queries also executed in the drill. See [drill-report](./drill-report.md). Owner: TenantForge maintainers._
