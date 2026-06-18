# TenantForge

> **The control plane for database-per-tenant SaaS, on Neon.**
> Provision an isolated Neon project per customer, route connections, run schema migrations across
> the whole fleet, and handle suspend / offboard / residency — so you get hard data isolation and a
> clean compliance story without building tenant provisioning, routing, and lifecycle yourself.

**Status:** `stable` (v0.3.0) — feature-complete and hardened. Implemented: the pure core
(slug/region validation, the tenant-lifecycle state machine, the fleet-migration planner) at 100%
test coverage; the Neon-API provisioning and Postgres registry / encrypted secret-store adapters; the
full lifecycle (`provision` / `suspend` / `resume` / `offboard` / `purge`, plus the scheduled
`purge-expired` sweep); connection routing; fleet-migration orchestration; per-tenant observability
and metering; residency enforcement; and a Neon-native (Postgres) queue + worker for async lifecycle
— all reachable as a **library**, **CLI**, **HTTP** control-plane API, and **MCP** server. Hardening
is complete: STRIDE threat model + abuse tests, per-operator auth + RBAC + rate limiting, a load/soak
harness, and the runbooks drilled — the live-Neon game-day (local + CI), the `NEON_API_KEY` rotation,
and a PITR row-level recovery all passed against a non-prod org. Tracked **Low residuals** (per-operator
OIDC) and the deferred alternate adapters (other brokers /
secret stores / exporters) are documented in [`docs/security/threat-model.md`](./docs/security/threat-model.md)
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
  batched/resumable with per-tenant status + rollback.
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
(comma-separated `id:role:token`, role = `admin` | `readonly`) for attributable identities
(constant-time token compare). In **`oidc`** mode, every request must carry a Bearer **JWT** verified
against an external issuer's JWKS (`TENANTFORGE_OIDC_ISSUER` / `TENANTFORGE_OIDC_AUDIENCE` /
`TENANTFORGE_OIDC_JWKS_URI`, via [`jose`](https://github.com/panva/jose)) — phishing-resistant,
no shared secrets; the principal id + role come from the `sub` / `role` claims
(`TENANTFORGE_OIDC_SUBJECT_CLAIM` / `_ROLE_CLAIM` to override), the signature algorithm is constrained
to an asymmetric allow-list (rejects `alg:none` / `HS*` confusion), and `iss`/`aud`/`exp` are checked.
RBAC is identical across modes: `readonly` may GET, only `admin` may mutate (403 otherwise). Every
`/v1/*` route is **rate-limited per principal**
(`TENANTFORGE_RATE_LIMIT` / `TENANTFORGE_RATE_WINDOW_MS`; 429 + `Retry-After` when exceeded). The
counter store is selected by `TENANTFORGE_RATE_LIMIT_STORE`: `memory` (default, per-instance) or
`pg` — a Postgres-backed (`tf_rate_limits`) store that makes the limit **global across instances**
for multi-replica deployments (Neon-native, zero extra deps), behind the `RateLimitStore` port.

**Secret backend** (where per-tenant connection secrets live) is selected by
`TENANTFORGE_SECRET_BACKEND`: `neon-pg` (default — AES-256-GCM-encrypted in the control-plane DB,
keyed by `TENANTFORGE_SECRET_KEY`) or `vault` (HashiCorp Vault KV v2, via `VAULT_ADDR` + `VAULT_TOKEN`,
optional `VAULT_KV_MOUNT` / `VAULT_PATH_PREFIX` / `VAULT_NAMESPACE`). Both satisfy the same
`SecretStore` port; config fails fast if the chosen backend's credentials are missing. Cloud secret
managers (AWS/GCP/Azure) can follow behind the same port in their own branches.

**Offboard export** is selected by `TENANTFORGE_EXPORTER`: `neon-archive` (default — retain the Neon
project scaled-to-zero, no data movement) or `pg-dump` (dump the tenant DB to an object store; set
`TENANTFORGE_EXPORT_DIR` to a durable mounted volume). Both satisfy the `TenantExporter` port and
export is fail-closed (offboard aborts before delete if the export can't be produced). S3 / GCS / R2
object stores can follow behind the `ObjectStore` port in their own branches.

## Operations

Runbooks live in [`docs/runbooks/`](./docs/runbooks/) ([index](./docs/runbooks/README.md)) — deploy,
rollback, [fleet-migration rollback](./docs/runbooks/fleet-migration-rollback.md), incident-response,
backup-restore, on-call, scaling, secret-rotation, and dependency-patch. A fleet migration is a
release; a cross-tenant leak or Neon-API-key compromise is a SEV1. The STRIDE
[threat model](./docs/security/threat-model.md) maps each trust boundary to its mitigation, residual
risks, and abuse tests. The HTTP API contract is
[`openapi.yaml`](./openapi.yaml). _(All runbook gates drilled against a non-prod org — game-day
(local + CI), `NEON_API_KEY` rotation, and a PITR row-level recovery; see the
[drill report](./docs/runbooks/drill-report.md).)_

**Per-tenant observability:** every control-plane operation emits a structured, tenant-scoped JSON
event (provision / transition / connection-resolved-or-denied / fleet-migration / purge-sweep) to
stdout as a 12-Factor event stream — carrying the tenant id, outcome, and timing, with connection
secrets always redacted. Plug a metrics/SIEM backend via the `EventSink` port.

**Per-tenant metering:** `usage <id> [--from --to]` reports a tenant's Neon resource consumption
(compute/active seconds, bytes written, peak storage) over a period for billing — pulled on demand
from Neon's consumption API via the `UsageProvider` port (no usage data stored in the control plane).

**Data residency:** provisioning is fail-closed on residency. A deployment can pin the regions
tenants may use via `TENANTFORGE_ALLOWED_REGIONS` (e.g. EU-only), and each provision may require a
jurisdiction (`--residency us|eu|apac`) that the chosen region must satisfy (std-privacy).

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
via `createTenantForge`; `ack`→DeleteMessage, `deadLetter`→DLQ (or SQS native redrive). Other brokers
(NATS/Pub/Sub) can follow behind the same port; an in-memory adapter backs tests/dev.

## Discoverability & rules

Publishes [`neon-tool.json`](./neon-tool.json) per the collection's
[discovery convention](../TOOLS.md). Inherits [`CLAUDE.md`](./CLAUDE.md) (TypeScript-service SSDLC
ruleset, multi-tenancy-focused).
