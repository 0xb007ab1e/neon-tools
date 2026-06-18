# Changelog

All notable changes to TenantForge are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **ResidencyRouter** (ARCHITECTURE #16) — `selectRegion` / `compliantRegions` in the pure core
  _choose_ a residency-compliant provisioning region from a jurisdiction + the org allow-list
  (deterministic, preferring the default when it qualifies), complementing the existing assert-style
  checks that validate an explicitly chosen region. `provision` now uses it: with no `region` but a
  required `residency`, a compliant region is auto-selected (e.g. `--residency eu` lands in an EU
  region without naming one); no compliant region fails closed (std-privacy). Pure, unit-tested at
  100%; backward-compatible (explicit-region path unchanged).

- **NATS JetStream message-queue backend** (`createNatsMessageQueue`) behind the `MessageQueue`
  port — the final deferred broker, alongside the Postgres / SQS / Pub/Sub / in-memory adapters. Zero
  new dependencies: it takes a minimal injected client (a `nats` JetStream pull consumer satisfies it
  via a small shim); JetStream provides the at-least-once delivery + per-message ack the port assumes.
  `receive` fetches and maps to `{ id, body }` retaining each message's ack/nak controls (malformed
  JSON passed through so the consumer dead-letters it); `ack` acks; `deadLetter` publishes to an
  optional DLQ subject + acks the original, or **nacks** for JetStream's native `MaxDeliver` +
  dead-letter advisory; `enqueue` publishes to the source subject. The irreversible `purge` is never
  a queue command. Unit-tested at 100%.

- **Google Pub/Sub message-queue backend** (`createPubSubMessageQueue`) behind the `MessageQueue`
  port — the lifecycle broker for GCP, alongside the Postgres / SQS / in-memory adapters. Zero new
  dependencies: it takes a minimal injected client (the `@google-cloud/pubsub` client satisfies it
  via a small shim), the SQS-adapter pattern. `receive` pulls and maps to `{ id: ackId, body }`
  (malformed JSON passed through so the consumer dead-letters it); `ack` acknowledges; `deadLetter`
  publishes to an optional DLQ topic + acks the original, or **nacks** (ack-deadline 0) for Pub/Sub's
  native dead-letter policy; `enqueue` publishes to the source topic. The irreversible `purge` is
  never a queue command. Unit-tested at 100%.

- **Azure Blob object store for export artifacts** (`createAzureBlobObjectStore`) behind the
  `ObjectStore` port — the off-Neon `pg_dump` sink for Azure Blob Storage, completing object-store
  parity across AWS/GCP/Azure (alongside filesystem). Zero new dependencies: it takes a minimal
  injected client (the `@azure/storage-blob` `BlobServiceClient` satisfies it via a small shim).
  `put` uploads under an optional `{prefix}/{key}` and returns a resolvable `https://…/{container}/{blob}`
  location when an `accountUrl` is set, else `azure-blob://{container}/{blob}`, plus byte size.
  Hand-wired via `createTenantForge` (compose into `createPgDumpExporter`). Unit-tested at 100%.

- **Azure Key Vault secret backend** (`createAzureKeyVaultStore`) behind the `SecretStore` port —
  the third deferred cloud secret manager (completing the big-three). Zero new dependencies: it
  speaks the Key Vault Secrets REST API directly via an injectable `fetch` + an injected AAD token
  provider (the Vault-adapter REST shape, not an SDK shim), with timeouts and a zod-validated read.
  `set` PUTs a new version; `get` returns null on 404; `delete` soft-deletes then **best-effort
  purges** to crypto-shred on offboard (workflow-data-lifecycle) — when purge-protection is enabled
  the purge is refused (403) and the secret is retained per policy; both steps are idempotent (404
  tolerated). Token + secret values never logged. Hand-wired via `createTenantForge`. Unit-tested at
  100%.

- **GCS object store for export artifacts** (`createGcsObjectStore`) behind the `ObjectStore` port —
  the off-Neon `pg_dump` sink for Google Cloud Storage, alongside the filesystem and S3 stores. Zero
  new dependencies: it takes a minimal injected client (the `@google-cloud/storage` `Storage` client
  satisfies it via a small shim). `put` writes under an optional `{prefix}/{key}` and returns a
  `gs://{bucket}/{key}` reference + byte size. Hand-wired via `createTenantForge` (compose into
  `createPgDumpExporter`). Unit-tested at 100%.

- **GCP Secret Manager secret backend** (`createGcpSecretManagerStore`) behind the `SecretStore`
  port — the second deferred cloud secret manager. Zero new dependencies: it takes a minimal injected
  client (the `@google-cloud/secret-manager` `SecretManagerServiceClient` satisfies it via a small
  shim). `set` creates the secret container (tolerating `ALREADY_EXISTS`) then adds a version; `get`
  accesses the `latest` version (null on `NOT_FOUND`); `delete` removes the secret and all versions
  to crypto-shred on offboard (workflow-data-lifecycle) and is idempotent. Secret values never logged;
  unhandled gRPC errors propagate. Hand-wired via `createTenantForge`. Unit-tested at 100%.

- **S3 object store for export artifacts** (`createS3ObjectStore`) behind the `ObjectStore` port —
  the off-Neon `pg_dump` sink alongside the filesystem store. Zero new dependencies: it takes a
  minimal injected client (the AWS SDK v3 `S3Client` satisfies it via a small shim), the SQS-queue
  pattern. `put` writes via `PutObject` under an optional `{prefix}/{key}` and returns an
  `s3://{bucket}/{key}` reference + byte size. The **same adapter serves Cloudflare R2 / MinIO / any
  S3-compatible store** — point the `S3Client` at that endpoint at the composition root. Hand-wired
  via `createTenantForge` (compose into `createPgDumpExporter`). Unit-tested at 100%.

- **AWS Secrets Manager secret backend** (`createAwsSecretsManagerStore`) behind the `SecretStore`
  port — the first of the deferred cloud secret managers. Zero new dependencies: it takes a minimal
  injected client (the AWS SDK v3 `SecretsManagerClient` satisfies it via a small shim), the same
  pattern as the SQS queue adapter. `set` writes a new version and creates the secret on first use;
  `get` returns null when absent; `delete` uses `ForceDeleteWithoutRecovery` to crypto-shred on
  offboard (workflow-data-lifecycle) and is idempotent. Secret values are never logged; non-not-found
  SDK errors propagate. Hand-wired via `createTenantForge` (not env-selectable — needs the SDK at the
  composition root). Unit-tested at 100%.

- **OIDC / JWT auth for the HTTP control plane** (threat-model R1, closed): authentication is now
  behind an `Authenticator` port (`src/ports/authenticator.ts`) with two adapters selected by
  `TENANTFORGE_AUTH_MODE`. `token` (default, unchanged) keeps the static per-operator credentials /
  admin-token shorthand with constant-time compare. `oidc` verifies a Bearer **JWT** against an
  external issuer's JWKS via [`jose`](https://github.com/panva/jose) — signature + `iss`/`aud`/`exp`
  checked, the algorithm constrained to an asymmetric allow-list (rejects `alg:none`/`HS*`
  confusion), the principal id + role read from the `sub`/`role` claims
  (`TENANTFORGE_OIDC_ISSUER` / `_AUDIENCE` / `_JWKS_URI`, optional `_SUBJECT_CLAIM` / `_ROLE_CLAIM`).
  Phishing-resistant, externally-managed identity with no shared secrets; RBAC is unchanged across
  modes. JWT verification is delegated to a vetted library, never hand-rolled (master §1). Both
  authenticators are unit-tested at 100% (`jose` `generateKeyPair`/`SignJWT` fixtures — valid /
  expired / wrong-aud / wrong-iss / wrong-key / disallowed-alg / missing-or-non-string-sub /
  invalid-role / custom-claims). Adds one dependency (`jose`, `pnpm audit --prod` clean).
- **Cross-instance rate limiting** (threat-model R2, closed): the HTTP rate limiter now counts via a
  `RateLimitStore` port — the default `createInMemoryRateLimitStore` (per-instance) plus a
  **Postgres-backed** `createPgRateLimitStore` (`tf_rate_limits`, migration 0004) that makes the
  per-principal limit **global across instances**. Selected by `TENANTFORGE_RATE_LIMIT_STORE`
  (`memory` | `pg`); wired in the HTTP entrypoint. No new dependencies (reuses `pg`); the in-memory
  store is unit-tested at 100% and the pg store has a self-skipping integration test (cross-instance
  sharing verified against an ephemeral Postgres).

### Changed

- **`DATABASE_URL` (registry-credential) rotation drilled** against a non-prod registry,
  non-destructively (the last Low residual from the `stable` promotion): the `secret-rotation.md`
  add-new-before-revoke-old flow was exercised via a throwaway least-privilege role — old and new
  credentials read the registry concurrently (dual-valid window proven), then revoke + `DROP ROLE`
  proved a rotated credential is rejected, with the primary credential untouched and no residue. See
  the [drill report](./docs/runbooks/drill-report.md); `secret-rotation.md` "Last validated" updated.

## [0.3.0] - 2026-06-18

First **stable** release. Every gating risk (R1–R4) is addressed/drilled — STRIDE threat model +
abuse tests, per-operator auth + RBAC + rate limiting, a load/soak harness, and the runbook game-day
(local **and** CI) plus `NEON_API_KEY` rotation and a **PITR row-level recovery**, all green against a
non-prod org. Remaining items are accepted **Low residuals** (per-operator OIDC, a multi-instance
shared rate-limit store, registry-credential rotation) tracked in `docs/security/threat-model.md`.

### Changed

- **Promoted to `stable` (v0.3.0).** `status` beta → stable; version 0.2.0 → 0.3.0 across the
  manifest, `package.json`, build metadata, and OpenAPI.
- **Neon PITR restore drilled** (threat-model R4 — closed): a canary row inserted into the primary
  registry was recovered in a point-in-time branch (row-level recovery verified end-to-end), then the
  marker was cleaned up. `backup-restore.md` now documents the revert paths (delete-the-branch /
  restore-from-the-auto-backup-branch).
- **`NEON_API_KEY` rotation drilled**: a rotated non-prod key was verified end-to-end by re-running
  the live game-day suite (10/10) on it.
- **Game-day validated in CI**: the `tenantforge-game-day` workflow ran the live suite green against
  the non-prod org (Environment secrets) — repeatable on demand, not just local.

### Security

- `.gitignore` now excludes editor swap/backup files (`*.swp`, `*~`, `.*.kate-swp`) — a Kate swap of
  `.env` was otherwise untracked-but-not-ignored, a credential-leak foot-gun.
- CI: bumped the pinned GitHub Actions off the deprecated Node-20 runtime (`actions/checkout` v6.0.3,
  `actions/setup-node` v6.4.0, `pnpm/action-setup` v6.0.9 — pinned by digest).

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

[0.3.0]: https://github.com/0xb007ab1e/neon-tools/releases/tag/tenantforge-v0.3.0
[0.2.0]: https://github.com/0xb007ab1e/neon-tools/releases/tag/tenantforge-v0.2.0
[0.1.0]: https://github.com/0xb007ab1e/neon-tools/releases/tag/tenantforge-v0.1.0
