# Changelog

All notable changes to TenantForge are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **`NEON_API_KEY` rotation drilled** (2026-06-17, threat-model R4): a rotated non-prod key was
  verified end-to-end by re-running the live game-day suite (10/10) on it — the `secret-rotation.md`
  verification step. Only the manual Neon PITR-restore console drill now remains before `stable`.

### Security

- `.gitignore` now excludes editor swap/backup files (`*.swp`, `*~`, `.*.kate-swp`) — a Kate swap of
  `.env` was otherwise untracked-but-not-ignored, a credential-leak foot-gun.

## [0.2.0] - 2026-06-17

Hardening release (still **beta**): security hardening + the alternate-backend adapters. Every
autonomous `stable` gate is closed (threat model, abuse tests, auth/RBAC/rate-limit, load harness,
automated live-Neon game-day); promotion to `stable` is gated only on the two manual console drills
(`NEON_API_KEY` rotation, Neon PITR restore) and accepting the tracked Low residuals
(`docs/security/threat-model.md`).

### Changed

- **Live-Neon game-day executed (2026-06-17, threat-model R4).** The integration suite ran against a
  dedicated non-prod Neon org — **10/10 passed, 0 skipped**: the full provision→purge lifecycle, a
  fleet migration + idempotent re-run + compensating revert on a canary, the provision round-trip,
  the Postgres queue/worker, and the registry assessment queries (all `gd-*`/canary projects
  auto-purged). Runbook footers + the drill report are stamped with the live result; only the
  manual-only `NEON_API_KEY` rotation and Neon PITR restore (console ops) remain to drill.

### Added

- **Load/soak harness for the fleet fan-out** (threat-model R3): `pnpm load` (`src/app/load.ts`)
  drives the real fleet orchestrator over a large synthetic fleet (configurable tenants / batch /
  simulated per-apply latency / failure rate), reporting throughput + peak concurrency and exiting
  non-zero if fan-out ever exceeds the batch bound. Backed by a fast CI regression test asserting
  bounded concurrency + failure-isolation + resumability at scale. The live-Neon load profile
  (pacing into real `429` limits) is documented as an operator-run procedure in `scaling.md`.
- **Per-operator HTTP auth + RBAC, and per-principal rate limiting** (threat-model R1/R2). The HTTP
  control plane now accepts named credentials (`TENANTFORGE_HTTP_CREDENTIALS` = `id:role:token`,
  role `admin` | `readonly`) with **constant-time** token compare and attributable identities;
  mutating routes require `admin` (`readonly` → 403, OWASP API5). A 1 MB body cap is joined by an
  in-app **fixed-window rate limit** per principal (429 + `Retry-After`; `TENANTFORGE_RATE_LIMIT` /
  `TENANTFORGE_RATE_WINDOW_MS`). The single-admin `TENANTFORGE_HTTP_TOKEN` remains as a shorthand
  (default behavior unchanged). OpenAPI documents 403/429 + the role model. No new dependencies
  (built-in `node:crypto`); the limiter is in-memory/per-instance (multi-instance needs a shared
  store — tracked).
- **Security hardening pass (toward `stable`).** A STRIDE **threat model**
  (`docs/security/threat-model.md`) documenting every trust boundary, its in-code mitigation,
  tracked residual risks (no in-app rate limiting, load/soak unverified, per-operator auth), and an
  abuse-case→test map. Backed by new **abuse/negative tests**: cross-tenant connection no-bleed
  (router + end-to-end `getConnection`), an exhaustive lifecycle transition matrix (all 5×5 pairs),
  every non-`active` status proven non-routable, and HTTP wrong-token (401) + over-large-body (413).
  Suite now 224 tests @ 100% core coverage.
- **AWS SQS message-queue backend** (`createSqsMessageQueue`) behind the `MessageQueue` port — an
  alternative to the default Postgres broker. **Zero new dependencies**: it takes a minimal injected
  client (`SqsClientLike`) that the AWS SDK v3 `SQSClient` satisfies via a small shim, so the SDK
  tree stays out of the project; wired via `createTenantForge`. `receive` long-polls and maps each
  message to `{ id: ReceiptHandle, body }`; `ack`→DeleteMessage; `deadLetter`→the app DLQ
  (SendMessage + delete) or, if unset, SQS's native redrive policy; `enqueue`→SendMessage. Fully
  unit-tested via a fake client (adapter at 100%).
- **`pg_dump` tenant exporter** (`createPgDumpExporter` + `spawnPgDump`) behind the `TenantExporter`
  port — the off-Neon, real-data-movement alternative to the retain-the-project archiver. Dumps a
  tenant's DB (custom format) and writes it to an `ObjectStore`; selectable via
  `TENANTFORGE_EXPORTER=pg-dump` with `TENANTFORGE_EXPORT_DIR`. `pg_dump` runs securely — password
  via `PGPASSWORD` env, never on argv; fixed arg array, no shell. Introduces the `ObjectStore` port
  with a **filesystem** adapter (`createFilesystemObjectStore`, path-traversal-confined); S3 / GCS /
  R2 adapters can follow behind it. Export stays fail-closed (offboard aborts before delete if the
  dump can't be produced).
- **HashiCorp Vault secret backend** (`createVaultSecretStore`, KV v2 over the HTTP API) as an
  alternative to the default `neon-pg` encrypted store, behind the same `SecretStore` port.
  Selectable via `TENANTFORGE_SECRET_BACKEND=vault` (`VAULT_ADDR` + `VAULT_TOKEN`, optional
  `VAULT_KV_MOUNT` / `VAULT_PATH_PREFIX` / `VAULT_NAMESPACE`); config fails fast if the chosen
  backend's credentials are missing. `delete` removes all versions + metadata (true crypto-shred).
  Cloud secret managers can follow behind the same port in their own branches.
- **Live-Neon game-day** (`docs/runbooks/game-day.md`): a documented, opt-in drill of the runbooks
  against a non-prod Neon org. Backed by two new self-skipping integration tests —
  `lifecycle.int.test.ts` (provision → suspend → resume → offboard → resume-restore → purge) and
  `fleet.int.test.ts` (fleet migrate → idempotent re-run → compensating revert) — plus a manual-only
  `NEON_API_KEY` rotation and PITR-restore procedure. Runnable via the maintainer-gated
  `tenantforge-game-day` GitHub Actions workflow (manual dispatch, preflight-guarded secrets) or
  `pnpm --filter tenantforge test:int` with non-prod credentials.
- Runbook **drill report** (`docs/runbooks/drill-report.md`) and an automated registry-query drill
  (`test/integration/drill.int.test.ts`) that runs the runbooks' documented `psql` assessment
  queries against the real schema. The registry & queue layers were executed against an ephemeral
  Postgres (7 integration tests pass); honest per-runbook validation footers replace the blanket
  "not yet drilled".

### Fixed

- `deploy.md` smoke test cited non-existent `offboard` flags (`--yes --skip-export --reason`);
  corrected to the real teardown (`offboard <id>` then `purge <id> --yes`).

## [0.1.0] - 2026-06-17

First **beta**: feature-complete for the v1 scope, behind real Neon adapters, pending runbook drills
and real-world validation.

### Added

- **Pure core (100% test coverage):** slug/region validation, the tenant-lifecycle state machine,
  the fleet-migration planner, retention, routing, observability, usage, and residency logic — all
  I/O-free.
- **Provisioning:** isolated Neon project per tenant via the Neon API; idempotent + resumable.
  Recorded in a control-plane Postgres registry (metadata only — never tenant data).
- **Lifecycle:** `provision` / `suspend` / `resume` / `offboard` (archive: retain scaled-to-zero,
  reversible) / `purge` (irreversible), plus the scheduled `purge-expired` retention sweep.
- **Connection routing:** tenant context derived server-side from the authenticated principal
  (never client-supplied); per-tenant connection secrets encrypted at rest (AES-256-GCM) in a
  Postgres-backed secret store.
- **Fleet migrations:** apply a versioned, backward-compatible (expand/contract) schema change
  across all active tenants — batched, resumable, per-tenant success/failure tracked, failure-isolated.
- **Per-tenant observability:** structured, tenant-scoped JSON events with secrets redacted, via the
  `EventSink` port.
- **Per-tenant metering:** on-demand Neon consumption reporting (compute/active seconds, bytes
  written, peak storage) via the `UsageProvider` port — no usage data stored in the control plane.
- **Data residency:** fail-closed region allow-list (`TENANTFORGE_ALLOWED_REGIONS`) and per-provision
  jurisdiction requirements (`--residency`).
- **Queue-driven lifecycle:** the `MessageQueue` port + a Neon-native Postgres broker
  (`tf_lifecycle_queue`, `FOR UPDATE SKIP LOCKED` + visibility timeout) and a poll-loop **worker**
  entrypoint with graceful shutdown; at-least-once-safe (dedupe by command id), poison messages
  dead-lettered. The irreversible `purge` is intentionally not a queue command.
- **Entrypoints:** library, CLI (`citty`), HTTP control-plane API (`Hono`, contract in
  `openapi.yaml`), and MCP server.
- **Operations:** runbooks for deploy, rollback, fleet-migration rollback, incident-response,
  backup-restore, on-call, scaling, secret-rotation, and dependency-patch _(drafted, not yet
  drilled)_.

### Known gaps

- Runbooks are drilled at the registry/queue layer (see `docs/runbooks/drill-report.md`); the
  live-Neon game-day (real provision/purge, key rotation, PITR restore) is still pending.
- Alternate adapters — other message brokers (SQS/NATS/Pub-Sub), Vault/cloud secret stores, and
  `pg_dump`→object-store exporters — are deferred to their own branches behind the existing ports.

[0.2.0]: https://github.com/0xb007ab1e/neon-tools/releases/tag/tenantforge-v0.2.0
[0.1.0]: https://github.com/0xb007ab1e/neon-tools/releases/tag/tenantforge-v0.1.0
