# TenantForge

[![version](https://img.shields.io/badge/version-0.7.0-blue)](https://github.com/0xb007ab1e/neon-tools/releases/tag/tenantforge-v0.7.0)

> **The control plane for database-per-tenant SaaS, on Neon.**
> Provision an isolated Neon project per customer, route connections, run schema migrations across
> the whole fleet, and handle suspend / offboard / residency — so you get hard data isolation and a
> clean compliance story without building tenant provisioning, routing, and lifecycle yourself.

**Status:** `stable` (v0.7.0) — feature-complete and hardened. Implemented: the pure core
(slug/region validation, the tenant-lifecycle state machine, the fleet-migration planner) at 100%
test coverage; the Neon-API provisioning and Postgres registry / encrypted secret-store adapters; the
full lifecycle (`provision` / `suspend` / `resume` / `offboard` / `purge`, plus the scheduled
`purge-expired` sweep); connection routing; fleet-migration orchestration; per-tenant observability
and metering; residency enforcement; and a Neon-native (Postgres) queue + worker for async lifecycle
— all reachable as a **library**, **CLI**, **HTTP** control-plane API, and **MCP** server. Hardening
is complete: STRIDE threat model + abuse tests, per-operator auth + RBAC + rate limiting, a load/soak
harness, and the runbooks drilled — the live-Neon game-day (local + CI), the `NEON_API_KEY` and
`DATABASE_URL` (registry-credential) rotations, and a PITR row-level recovery all passed against a
non-prod org. The remaining **Low residuals** — the deferred alternate adapters (other brokers /
secret stores / exporters) — are documented in [`docs/security/threat-model.md`](./docs/security/threat-model.md)
and deferred to their own branches. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the design, scope,
and milestones.

## Quickstart

```bash
cp .env.example .env            # fill in DATABASE_URL, NEON_API_KEY, NEON_ORG_ID
pnpm --filter tenantforge cli migrate          # create the control-plane registry schema
pnpm --filter tenantforge cli provision acme   # provision an isolated Neon project for tenant "acme"
pnpm --filter tenantforge cli list             # list tenants
```

As a library:

```ts
import { tenantForgeFromEnv } from '@neon-tools/tenantforge';

const tf = tenantForgeFromEnv();
await tf.migrate();
const { tenant } = await tf.provision({ slug: 'acme', region: 'aws-eu-central-1' });
await tf.close();
```

## Why

Multi-tenant SaaS usually picks shared-schema (`tenant_id`) and inherits a one-bug-from-a-breach
isolation risk, or pays an always-on database per tenant. Neon changes the economics: a Postgres
**project per tenant** gives **physical isolation** (great for HIPAA/SOC2 + per-region residency),
and **scale-to-zero** means idle tenants cost ~$0. TenantForge is the managed control plane over
that primitive — the provisioning, routing, fleet-migration orchestration, and lifecycle that are
painful to build correctly.

## What it does

- **Provision** a tenant → an isolated Neon project (region-selectable), recorded in a control-plane
  registry. Idempotent + resumable.
- **Route** an authenticated principal → its tenant's connection (tenant context derived
  server-side — never from the client).
- **Migrate the fleet** — apply a versioned, backward-compatible schema change across all tenants,
  batched/resumable with per-tenant status + rollback. **Canary** a tenant first
  (`migrateFleet(spec, { canaryTenantId })` aborts the rollout if the canary fails), and check
  **drift** any time with `fleetStatus()` (which active tenants are behind the latest version or
  failing).
- **Reconcile the fleet** — the actuator behind drift: `reconcileFleet(catalog, opts)` (CLI
  `reconcile-fleet <migrations-dir>`) brings every behind/failed tenant up to the target by applying
  its **missing versions in order, stopping at a tenant's first failure** (ordered-dependency-safe),
  failure-isolated and idempotent/resumable, with an optional **canary**. Preview first with
  `reconcilePlan()` / `reconcile-fleet --plan` / HTTP `GET /v1/fleet/reconcile` / the dashboard
  reconcile panel (read-only — no SQL needed). Execution needs the SQL catalog: the library/CLI, or —
  when the server is started with `TENANTFORGE_MIGRATIONS_DIR` — a **`tenant:provision`-gated**
  "Run reconcile" button in the dashboard (`POST /dashboard/api/reconcile`, CSRF-defended, audited).
- **Lifecycle** — suspend / resume / **offboard** (archive: retain the project scaled-to-zero,
  reversible) → **purge** (irreversible delete). `purge-expired` is the scheduled sweep that purges
  archived tenants past `TENANTFORGE_RETENTION_DAYS` (run by a cron / K8s CronJob).
- Use it as a **library**, a **CLI**, an **HTTP control-plane API**, or an **MCP server**.

## Composition

TenantForge is the **SaaS shell** the other collection tools run inside. Most directly, each tenant's
isolated Postgres can host that tenant's vectors via [**VectorNest**](../vectornest/) — one database,
relational + vectors, per tenant. It `consumes` `rag.*` and `provides` `tenant.*` capabilities (see
[`neon-tool.json`](./neon-tool.json)).

## Configuration

Secrets come from the environment (never committed). See [`.env.example`](./.env.example):
`NEON_API_KEY` + `NEON_ORG_ID` (provision projects — the account is org-scoped), `DATABASE_URL` (the
control-plane registry DB), and the HTTP auth (below).

**HTTP control-plane auth** has two modes, selected by `TENANTFORGE_AUTH_MODE` (default `token`),
both resolving a request to a principal `{ id, role }` behind the `Authenticator` port. In **`token`**
mode, `TENANTFORGE_HTTP_TOKEN` is a single-admin shorthand, or set `TENANTFORGE_HTTP_CREDENTIALS`
(comma-separated `id:role:token`, role = `admin` | `operator` | `readonly`) for attributable identities
(constant-time token compare). In **`oidc`** mode, every request must carry a Bearer **JWT** verified
against an external issuer's JWKS (`TENANTFORGE_OIDC_ISSUER` / `TENANTFORGE_OIDC_AUDIENCE` /
`TENANTFORGE_OIDC_JWKS_URI`, via [`jose`](https://github.com/panva/jose)) — phishing-resistant,
no shared secrets; the principal id + role come from the `sub` / `role` claims
(`TENANTFORGE_OIDC_SUBJECT_CLAIM` / `_ROLE_CLAIM` to override), the signature algorithm is constrained
to an asymmetric allow-list (rejects `alg:none` / `HS*` confusion), and `iss`/`aud`/`exp` are checked.
RBAC is identical across modes: a required **permission per operation** is enforced server-side,
deny by default — `admin` holds all, `operator` runs the reversible lifecycle but cannot
`tenant:purge`, `readonly` may only read (403 otherwise); a token may carry an explicit permission
set to narrow its role. Every
`/v1/*` route is **rate-limited per principal**
(`TENANTFORGE_RATE_LIMIT` / `TENANTFORGE_RATE_WINDOW_MS`; 429 + `Retry-After` when exceeded). The
counter store is selected by `TENANTFORGE_RATE_LIMIT_STORE`: `memory` (default, per-instance) or
`pg` — a Postgres-backed (`tf_rate_limits`) store that makes the limit **global across instances**
for multi-replica deployments (Neon-native, zero extra deps), behind the `RateLimitStore` port.

**Secret backend** (where per-tenant connection secrets live) is selected by
`TENANTFORGE_SECRET_BACKEND`: `neon-pg` (default — AES-256-GCM-encrypted in the control-plane DB,
keyed by `TENANTFORGE_SECRET_KEY`) or `vault` (HashiCorp Vault KV v2, via `VAULT_ADDR` + `VAULT_TOKEN`,
optional `VAULT_KV_MOUNT` / `VAULT_PATH_PREFIX` / `VAULT_NAMESPACE`). Both satisfy the same
`SecretStore` port; config fails fast if the chosen backend's credentials are missing. **Cloud secret
managers** ship behind the same port for hand-wiring via `createTenantForge` (not env-selectable, since
they need their SDK at the composition root — same approach as the SQS queue): **AWS Secrets Manager**
(`createAwsSecretsManagerStore`) takes a minimal injected client (wrap your
`@aws-sdk/client-secrets-manager` client with a small shim) so it adds **zero dependencies**; `set`
creates-or-updates the secret and `delete` force-deletes without a recovery window (crypto-shred on
offboard). **GCP Secret Manager** (`createGcpSecretManagerStore`) follows the same shape over the
`@google-cloud/secret-manager` client: `set` creates the secret then adds a version, `get` accesses
`latest`, and `delete` removes the secret and all versions (crypto-shred). **Azure Key Vault**
(`createAzureKeyVaultStore`) speaks the Key Vault REST API directly (injectable `fetch` + an injected
AAD token provider, no SDK): `set` PUTs a version, `get` reads the value, and `delete` soft-deletes
then best-effort **purges** to crypto-shred (retained per policy when purge-protection is on).

**Offboard export** is selected by `TENANTFORGE_EXPORTER`: `neon-archive` (default — retain the Neon
project scaled-to-zero, no data movement) or `pg-dump` (dump the tenant DB to an object store; set
`TENANTFORGE_EXPORT_DIR` to a durable mounted volume). Both satisfy the `TenantExporter` port and
export is fail-closed (offboard aborts before delete if the export can't be produced). The `pg-dump`
sink is pluggable behind the `ObjectStore` port: a filesystem store ships, and an **S3** store
(`createS3ObjectStore`) ships for hand-wiring via `createTenantForge` — it takes a minimal injected
client (wrap your `@aws-sdk/client-s3` `S3Client`) so it adds **zero dependencies**, and the **same
adapter serves Cloudflare R2 / MinIO / any S3-compatible store** by pointing the `S3Client` at that
endpoint. A **GCS** store (`createGcsObjectStore`, over the `@google-cloud/storage` client, `gs://`
references) and an **Azure Blob** store (`createAzureBlobObjectStore`, over the `@azure/storage-blob`
client) ship the same way — completing object-store parity across the big three.

## Operations

Runbooks live in [`docs/runbooks/`](./docs/runbooks/) ([index](./docs/runbooks/README.md)) — deploy,
rollback, [fleet-migration rollback](./docs/runbooks/fleet-migration-rollback.md), incident-response,
backup-restore, on-call, scaling, secret-rotation, and dependency-patch. A fleet migration is a
release; a cross-tenant leak or Neon-API-key compromise is a SEV1. The STRIDE
[threat model](./docs/security/threat-model.md) maps each trust boundary to its mitigation, residual
risks, and abuse tests. The HTTP API contract is
[`openapi.yaml`](./openapi.yaml). _(All runbook gates drilled against a non-prod org — game-day
(local + CI), `NEON_API_KEY` and `DATABASE_URL` rotations, and a PITR row-level recovery; see the
[drill report](./docs/runbooks/drill-report.md).)_

**Per-tenant observability:** every control-plane operation emits a structured, tenant-scoped JSON
event (provision / transition / connection-resolved-or-denied / fleet-migration / purge-sweep) to
stdout as a 12-Factor event stream — carrying the tenant id, outcome, and timing, with connection
secrets always redacted. Plug a metrics/SIEM backend via the `EventSink` port.

**Metrics (Prometheus):** the HTTP entrypoint derives **RED metrics from that same event stream** (no
extra instrumentation) via `createMetricsEventSink` fanned out alongside the JSON sink
(`createFanOutEventSink`), and serves them at `GET /metrics` in Prometheus text format —
`tenantforge_events_total{event,outcome}` (rate + errors) and a `tenantforge_event_duration_ms`
histogram (duration). The endpoint is unauthenticated (an internal scrape target, like the probes).

**Outbound webhooks (optional):** set `TENANTFORGE_WEBHOOK_URL` (https) + `TENANTFORGE_WEBHOOK_SECRET`
to fan lifecycle events out to an external endpoint (billing/CRM/alerting) via `createWebhookEventSink`.
Each POST is **HMAC-SHA256 signed** (`X-TenantForge-Signature: sha256=…` over `"{timestamp}.{body}"`,
with `X-TenantForge-Timestamp` for replay defence), **never follows redirects** (SSRF defence), and
**retries with exponential backoff + jitter** before dead-lettering (logged via `onError`). Scope it
with `TENANTFORGE_WEBHOOK_EVENTS` (comma-separated allow-list). Delivery is best-effort and
non-blocking — it never delays or breaks a control-plane operation.

**Per-tenant metering:** `usage <id> [--from --to]` reports a tenant's Neon resource consumption
(compute/active seconds, bytes written, peak storage) over a period for billing — pulled on demand
from Neon's consumption API via the `UsageProvider` port (no usage data stored in the control plane).

**Compliance report:** `tf.complianceReport()` (CLI `compliance-report`, HTTP `GET
/v1/compliance/report`) emits a registry-derived **isolation + residency attestation** with a
SHA-256 integrity digest — flags shared/missing tenant projects and out-of-allow-list regions; CLI
exits non-zero on a violation (cron/CI gate). Evidence, not legal certification. With a **persisted
audit trail** (`TENANTFORGE_AUDIT_LOG=pg`; the `AuditLogStore` port + `tf_audit_log`) the report also
attests **erasure history** (tenant deletions, with operator attribution) and a **recent audit
excerpt** — the durable, queryable record behind the ephemeral stdout event stream.

**Cost / margin:** `tf.costReport(period)` (CLI `cost-report`, HTTP `GET /v1/cost/report`, dashboard panel) estimates each tenant's Neon cost (from `TENANTFORGE_COST_RATES`) vs. its price (`metadata.priceUsd`) and flags unprofitable/unpriced tenants — a read-only **cost-attribution estimate**, not an invoice.

**Invoices:** `tf.invoice(id, period)` / `invoiceFleet(period)` (CLI `invoice` / `invoice-fleet`, HTTP `GET /v1/tenants/:id/invoice` + `GET /v1/invoices`, dashboard panel) generate per-tenant **invoice documents** — usage billed at your **billing (sell) rates** (`TENANTFORGE_BILLING_RATES`) plus the flat plan fee (`metadata.priceUsd`), as line items + total. These are billable **artifacts**; to actually charge them, see Charging below.

**Charging (PSP):** `tf.chargeInvoice(id, period)` / `chargeInvoiceFleet(period)` (CLI `charge` / `charge-fleet`, **`--yes`-gated**) charge a tenant's invoice via the configured gateway behind the swappable **`PaymentGateway` port** — **Stripe** ships (REST + injectable `fetch`, zero SDK dep); plug in any other PSP/billing agent the same way. Money is integer minor units; charges are **idempotent** (no double-bill); the tenant's PSP customer id is `metadata.billingCustomerRef`. Opt-in via `TENANTFORGE_PAYMENT_GATEWAY=stripe` + `STRIPE_SECRET_KEY`. **Charging is CLI-only and gated — never over HTTP or MCP** (money movement, LLM08); HTTP `GET /v1/billing/charges` + the dashboard billing panel show **read-only** charge history.

**Inbound PSP webhooks:** `POST /webhooks/payment` ingests payment events (Stripe `payment_intent.succeeded` / `payment_failed` / `charge.refunded`) behind the swappable **`PaymentWebhookVerifier` port** — authenticated by the **signature** (HMAC over the raw body, constant-time, replay-checked), **not** the bearer token, so it lives outside `/v1`. Verified events become redacted `payment.webhook` audit records (charges stamp `metadata.tenant_id` so events correlate back to the tenant); read them via `GET /v1/billing/webhook-events` + the dashboard billing panel. Enable with `TENANTFORGE_PAYMENT_WEBHOOK_SECRET`.

**Web dashboard:** a React/Vite SPA (`dashboard/`) gives operators a browser view of the control
plane — panels for compliance, fleet drift, and cost/margin. It logs in with an operator token
exchanged for an **HttpOnly session cookie** by the `/dashboard` backend (mounted when
`TENANTFORGE_DASHBOARD_SECRET` is set), then reads `/dashboard/api/*`. WCAG 2.2 AA semantic HTML
(enforced by jsx-a11y lint + axe tests). Dev: `pnpm dashboard:dev` (tailnet-only — loopback by
default, `DASHBOARD_HOST` for a Tailscale IP; never public). In **production**, set
`TENANTFORGE_DASHBOARD_DIST=./dashboard/dist` (after `pnpm dashboard:build`) and the control-plane
server serves the built SPA under `/dashboard` itself — no separate web server. The CLI/HTTP/MCP
surfaces remain the automation path; the dashboard is the human window onto each feature.

**Per-tenant quotas:** `tf.checkQuota(id, period, quota)` / `checkQuotas(...)` (CLI `check-quotas
--max-storage-gb / --max-compute-seconds`) meter consumption and evaluate it against per-tenant
limits with the pure `evaluateQuota`, emitting `tenant.quota_exceeded` on a breach. **Enforcement is
opt-in** — detection + alerting by default; `--enforce` suspends over-quota tenants (reversible),
since auto-suspending is impactful.

**Right to erasure (GDPR Art. 17 / CCPA):** `tf.erase(id, { reason })` (the **ErasureEngine**) is the
legal-override deletion path — it applies from **any** state (unlike `purge`, which requires an
offboarded tenant). It optionally produces a final subject export, deletes the Neon project,
crypto-shreds the connection secret, marks the record `deleted`, then **verifies** the post-conditions
(secret unreadable + status deleted) and returns an auditable **erasure certificate** (no secrets) —
emitted as a `tenant.erased` event (`outcome: 'error'` if a post-condition fails, so monitoring
catches an incomplete erasure). The control-plane registry holds no tenant content, so this erases the
personal data. `createErasureEngine` is also exported for standalone composition.

**Secret rotation:** `tf.rotateSecret(id)` rotates one tenant's connection credential (mint a new
one on its Neon project, store it, invalidate the cached connection); `tf.rotateSecrets()` is the
**fleet sweep** (failure-isolated — run by a cron / K8s CronJob) — automating the per-tenant
connection-secret procedure in `docs/runbooks/secret-rotation.md`. Each emits a
`tenant.secret_rotated` audit event; the old/new URIs are never logged. Also `createSecretRotationEngine`.

**Backup & restore:** `pg_dump` backs the offboard exporter (backup); the matching **restore** is
`spawnPgRestore` (archive → `pg_restore` into a target DB, password off-argv, archive on stdin), and
`createPgDataMover` pipes **`pg_dump` → `pg_restore`** to copy a tenant between databases — the
concrete `TenantDataMover` the re-home engine uses (wired by default in the production composition
root, so it needs `pg_dump`/`pg_restore` on PATH). PITR recovery via Neon branches stays operator-run
(`docs/runbooks/backup-restore.md`).

**Scheduled snapshots:** `tf.snapshot(id)` takes a point-in-time snapshot as a **Neon branch**
(copy-on-write — instant, cheap); `snapshotFleet()` / `pruneSnapshots()` are the failure-isolated
cron sweeps (CLI: `snapshot-fleet`, `prune-snapshots --max-count/--max-age-days`), the pure
`planSnapshotPrune` deciding what to drop; `restoreSnapshot(id, branchId)` (CLI `restore-snapshot`,
destructive) resets the tenant to a snapshot. Snapshots are restore points against corruption / bad
migrations — **not** project deletion (they live in the project); for long-term off-Neon durability,
use the `pg_dump` archive path.

**Off-Neon archive tier:** `tf.archive(id)` / `archiveFleet()` (CLI `archive`, `archive-fleet`)
`pg_dump` each active tenant to an object store (`archives/` prefix) — durable, **survives project
deletion**, for long-term/compliance retention. Enabled when an export object store is configured
(`TENANTFORGE_EXPORT_DIR`); archive **retention is the object store's lifecycle policy** (S3/GCS),
not app-managed.

**Re-homing (residency change):** `tf.rehome(id, { region, residency? })` relocates an **active**
tenant to a new region — for a residency change (e.g. a customer moves to the EU) or latency. A Neon
project is region-bound, so it **provisions a new project in the target region, copies the data**
(via an injected `TenantDataMover` — the same machinery as backup/restore), switches the registry +
connection secret over, then decommissions the old project. **Fail closed / never lose data:** the
target is validated first (allow-list + jurisdiction, must differ from current), and a copy failure
rolls back the new project leaving the source intact; the old project is deleted only after the
switch (best-effort). Exposed as the standalone `createRehomeEngine`.

**Data residency:** provisioning is fail-closed on residency. A deployment can pin the regions
tenants may use via `TENANTFORGE_ALLOWED_REGIONS` (e.g. EU-only), and each provision may require a
jurisdiction (`--residency us|eu|apac`). With an explicit region, that region must satisfy the
jurisdiction; **with no region, the ResidencyRouter selects a compliant one** from the allow-list
(preferring the default when it qualifies) — so `provision --residency eu` lands in an EU region
without naming it. No compliant region ⇒ provisioning fails closed (std-privacy).

**Queue-driven lifecycle (optional):** lifecycle commands (provision / suspend / resume / offboard)
can be consumed from a queue via the `MessageQueue` port + `createLifecycleConsumer` —
at-least-once-safe (dedupe by command id), poison/failure messages dead-lettered, failure-isolated.
The irreversible `purge` is intentionally not a queue command. The default broker is **Neon-native**:
a Postgres-backed queue (`tf_lifecycle_queue`, migration `0003`) that claims rows with
`FOR UPDATE SKIP LOCKED` + a visibility timeout, so multiple workers consume without
double-processing and a crashed worker's messages reappear. Run the worker and enqueue commands:

```sh
pnpm --filter tenantforge worker                          # poll-loop worker; drains the queue
pnpm --filter tenantforge cli enqueue provision acme      # producer (validates before enqueuing)
pnpm --filter tenantforge cli enqueue suspend --tenant-id <uuid>
```

The worker polls every `TENANTFORGE_QUEUE_POLL_MS` (default 5000) and shuts down gracefully on
SIGINT/SIGTERM. An **AWS SQS** backend (`createSqsMessageQueue`) implements the same `MessageQueue`
port — it carries **zero new dependencies** by taking a minimal injected client (wrap your
`@aws-sdk/client-sqs` `SQSClient` with a small shim, per the adapter's doc comment) and hand-wiring it
via `createTenantForge`; `ack`→DeleteMessage, `deadLetter`→DLQ (or SQS native redrive). A **Google
Pub/Sub** backend (`createPubSubMessageQueue`) implements the same port the same zero-dependency way
(wrap your `@google-cloud/pubsub` client): `receive`→pull, `ack`→acknowledge, `deadLetter`→publish to
a DLQ topic + ack (or nack for Pub/Sub's native dead-letter policy). A **NATS JetStream** backend
(`createNatsMessageQueue`) does the same (wrap your `nats` pull consumer): `receive`→fetch,
`ack`→ack, `deadLetter`→publish to a DLQ subject + ack (or nack for JetStream's `MaxDeliver` +
dead-letter advisory). An in-memory adapter backs tests/dev.

**Health & readiness:** `GET /health` is a static **liveness** probe (the process is up). `GET /ready`
is a **readiness** probe — it calls `TenantForge.health()`, which checks registry connectivity (the
hard dependency) and returns `200` when healthy or `503` when degraded, so an orchestrator stops
routing to an instance that can't serve. `health()` is fail-soft (never throws). The Neon API is a
per-call upstream with its own timeouts/retries and is deliberately not probed on every readiness tick.

**Connection routing & caching:** `getConnection(id)` resolves a server-derived tenant id to its
connection (registry read + secret fetch), failing closed for any non-active/unprovisioned tenant.
Set `TENANTFORGE_CONNECTION_CACHE_TTL_MS` (0 = off) to cache resolutions in a **process-local,
tenant-keyed, single-flight LRU** (`createCachingConnectionRouter`) — invalidated automatically on
every lifecycle transition and erasure, and TTL-bounded as a staleness backstop. This caches
_resolution_ only; managing live database **connection pools** is the data-plane consumer's job
(TenantForge hands out a URI, not a pool — pool it on your side, keyed per tenant, with sane caps).

## Discoverability & rules

Publishes [`neon-tool.json`](./neon-tool.json) per the collection's
[discovery convention](../TOOLS.md). Inherits [`CLAUDE.md`](./CLAUDE.md) (TypeScript-service SSDLC
ruleset, multi-tenancy-focused).
