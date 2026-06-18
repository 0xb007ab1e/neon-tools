# Changelog

All notable changes to TenantForge are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

[0.1.0]: https://github.com/0xb007ab1e/neon-tools/releases/tag/tenantforge-v0.1.0
