# TenantForge

[![version](https://img.shields.io/badge/version-0.36.0-blue)](https://github.com/0xb007ab1e/neon-tools/releases/tag/tenantforge-v0.36.0)

> **The control plane for database-per-tenant SaaS, on Neon.**
> Provision an isolated Neon project per customer, route connections, run schema migrations across
> the whole fleet, and handle suspend / offboard / residency — so you get hard data isolation and a
> clean compliance story without building tenant provisioning, routing, and lifecycle yourself.

**Status:** `stable` (v0.36.0) — feature-complete and hardened. Implemented: the pure core
(slug/region validation, the tenant-lifecycle state machine, the fleet-migration planner) at 100%
test coverage; the Neon-API provisioning and Postgres registry / encrypted secret-store adapters; the
full lifecycle (`provision` / `suspend` / `resume` / `offboard` / `restore` / `purge`, plus the scheduled
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
- **Import** an _existing_ Neon project → adopt it as a managed tenant without creating one
  (migration onboarding): `tf.importTenant({ slug, neonProjectId, connectionUri, region?, residency? })`
  (CLI `import`, HTTP `POST /v1/tenants/import`). Same slug + region/residency validation as provision;
  fails closed if the slug is in use. The connection URI is a **secret** supplied by the operator
  (CLI reads it from `TENANTFORGE_IMPORT_CONNECTION_URI`, HTTP from the request body) — stored
  server-side, never echoed or logged. **CLI/HTTP only** (it accepts a secret — off the MCP + dashboard
  surfaces). Builder-side — mapping an existing project to your tenant identity is knowledge Neon lacks.
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
  reversible) / **restore** (un-archive an offboarded tenant back to active, gated to the retention
  window) → **purge** (irreversible delete). `purge-expired` is the scheduled sweep that purges
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

## Security: TLS & network surface

Every connection is TLS by default, and TenantForge **fails closed at startup** on a plaintext one
(master §5 — no plaintext protocols). This section documents what is enforced, the two escape
hatches, and the **intentionally-open endpoints** (the "potentially leaky" surface) so the trade-off
is explicit rather than implicit.

**Outbound — enforced (the app rejects a plaintext target before connecting):**

- **Postgres** (control-plane registry, encrypted secret store, message queue, rate-limit /
  idempotency / audit stores, per-tenant migration + dump/restore connections): the connection
  string must carry `sslmode=require` (or `verify-ca` / `verify-full`). Neon always requires TLS, so
  a real Neon URL passes; a misconfigured self-hosted target with `sslmode=disable`/`prefer`/absent
  is refused. Guard: `assertPostgresTls` (`src/core/transport-security.ts`).
- **HTTPS APIs** (Neon API, HashiCorp Vault, Azure Key Vault, OIDC JWKS, Stripe): the URL must be
  `https://` — checked at adapter construction (`assertHttpsUrl`). The defaults are already https;
  this catches a bad `*_BASE_URL` / `VAULT_ADDR` / `JWKS_URI` override. A plaintext JWKS in
  particular is a trivial key-substitution MITM, so it is hard-refused.
- **Outbound lifecycle webhooks** require `https://` (the webhook sink enforces it independently) and
  do not follow redirects (SSRF defense).
- **Cloud SDK adapters** (AWS/GCP/Azure Secrets Managers, SQS, Pub/Sub, S3, GCS, Blob): TLS is
  enforced by the vendor SDK, which talks https to the service endpoint by default.

**The two escape hatches (local dev only — the documented leaky endpoints):**

- `TENANTFORGE_ALLOW_INSECURE_DB=true` permits a non-TLS Postgres connection.
- `TENANTFORGE_ALLOW_INSECURE_URLS=true` permits a non-https outbound URL (Neon / Vault / KV / OIDC
  / Stripe).

Both default to `false`. Set them **only** for local development against a loopback service that has
no certificate. Enabling either in production sends credentials and tenant data over plaintext —
never do it; there is no production reason to.

**Inbound — TLS terminated at the edge (the acknowledged design boundary):** the HTTP control-plane
and dashboard servers (Hono) **do not terminate TLS themselves**. Deploy them **behind a
TLS-terminating reverse proxy / load balancer** (nginx, Caddy, a cloud LB) and **never expose the
listener port directly to the internet**. In dev/preview the listener is **tailnet-only, never
public** ([topic-tailnet-dev-access]) — bound to the host's Tailscale IP + loopback, reached at
`http://<host>:<port>` over WireGuard, with app auth still on. This is the one place plaintext can
exist on the wire (proxy↔app on a trusted local hop / encrypted tailnet), and it is a deliberate,
documented deploy contract — not an open door to the public internet.

**Deliberately-unauthenticated endpoints (each open by design, with its risk):**

| Endpoint                 | Why it is open                                            | Risk / mitigation                                                                                                                                             |
| ------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`            | Liveness probe — must answer before auth is in play.      | No secrets, no dependency calls; returns a static `ok`. Lowest-value surface.                                                                                 |
| `GET /ready`             | Readiness probe — gates traffic on registry connectivity. | Reveals only up/down of a dependency; no data. Keep it off the public internet.                                                                               |
| `GET /metrics`           | Prometheus scrape (opt-in; only when `metrics` is set).   | Operational counters only (no PII/secrets). Scope to the metrics network.                                                                                     |
| `POST /webhooks/payment` | The PSP can't present a bearer token.                     | Authenticated by **HMAC signature over the raw body** (constant-time, replay-checked) — the signature _is_ the auth; an unsigned/forged call is rejected 400. |

Everything under **`/v1/*`** requires authentication (static token or OIDC JWT) + per-principal rate
limiting; the **MCP** server uses a **stdio** transport (a subprocess of the LLM host — not a network
listener, so there is no port to expose); money-moving / destructive operations are **CLI-only and
gated** and are never reachable over HTTP or MCP.

The **MCP tool surface mirrors the HTTP reads** (LLM08 least-agency): lifecycle (provision / suspend /
resume / offboard — purge excluded) plus read-only reports — compliance, cost (+ `tf_cost_anomalies`),
invoices, the filterable **audit trail** (`tf_audit`, which subsumes the per-event billing/lifecycle
histories via its `events` filter), `tf_audit_anomalies`, `tf_retention`, `tf_plans`,
`tf_signup_tokens`, and `tf_credit_balance`. Money-moving / resource-creating ops (charge, refund,
credit grant, plan settlement, signup issue/redeem, data export, fleet-reconcile execution) stay off
MCP — read their results via the audit/report tools, run them via the CLI.

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

**Mutation testing (critical-path test quality):** coverage proves lines _ran_, not that a test would
_catch a fault_ — so the money + authorization core (billing/proration/refunds, credit, invoicing,
cost/anomaly, dunning, authz) is mutation-tested with **Stryker** (`pnpm mutation`). A
[CI job](../.github/workflows/mutation.yml) runs it when that core or its tests change (plus weekly),
failing below a `break` mutation-score threshold so a change that weakens those tests is caught. The
remaining surviving mutants are equivalent (e.g. proration boundaries that fall through to the same
value), which is why the bar is the practical ceiling for these modules rather than 100%.

**Contract tests (the surfaces honor their published contracts):** the HTTP control plane is tested
against [`openapi.yaml`](./openapi.yaml) in two directions — a **route inventory** check (served
routes == documented routes, catching shadow/zombie endpoints — OWASP API9) and **response-shape**
validation (representative responses are validated with `ajv` against the resolved OpenAPI response
schema for that path/method/status). The MCP agent surface is checked too: every advertised tool
ships a documented, well-formed object input schema. So the wire contract can't drift from the spec
silently.

**Supply chain & CI gates:** every PR runs merge-blocking gates — lint/format, type-check, the
six-site version gate, unit + integration tests with coverage thresholds (100% on the pure core),
`pnpm audit` (SCA), **CodeQL** (SAST), **gitleaks** (secret scan), and a **supply-chain** job that
emits a **CycloneDX SBOM** and runs a **Trivy** filesystem vuln + misconfig scan (blocks on fixable
HIGH/CRITICAL). On a `tenantforge-v*` tag, the **release** workflow builds the artifact once, attests
**non-falsifiable SLSA build provenance** (keyless via OIDC — no stored signing keys), and publishes
a GitHub Release with the tarball + SBOM; verify with `gh attestation verify <tarball> --repo <repo>`.
All third-party actions are pinned by commit SHA. _(A hardened, scanned + signed container image is a
deferred follow-up — it needs a registry + deploy-target decision.)_

**Per-tenant observability:** every control-plane operation emits a structured, tenant-scoped JSON
event (provision / transition / connection-resolved-or-denied / fleet-migration / purge-sweep) to
stdout as a 12-Factor event stream — carrying the tenant id, outcome, timing, and a
**`correlationId`**, with connection secrets always redacted. Plug a metrics/SIEM backend via the
`EventSink` port.

**Distributed tracing + correlation IDs (OpenTelemetry):** every operation runs in a trace scope
established at the boundary — HTTP middleware, each CLI invocation, each MCP tool call. It continues
an inbound W3C **`traceparent`** (or a host OTel SDK's active trace) or generates one; the **trace id
is the `correlationId`** stamped on every emitted event, so one operation's logs tie together and
across services. HTTP responses echo it as **`x-correlation-id`**, and the trace is propagated to the
upstream **Neon API** as a `traceparent` header. The pure W3C parse/format/validate lives in the core
(`src/core/trace.ts`, 100% covered — an inbound header is untrusted and fails closed). Following the
**instrumented-library pattern, the tool depends only on `@opentelemetry/api`** (no-op + ~zero cost by
default): spans export and adopt the real trace id when the **host configures an OpenTelemetry SDK** —
e.g. run the standalone server with `node --import @opentelemetry/auto-instrumentations-node/register`
and set `OTEL_EXPORTER_OTLP_ENDPOINT`. Builder-side — application-level request correlation across
auth/lifecycle/billing and into Neon is knowledge Neon doesn't have.

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

**Signup / onboarding tokens:** `tf.issueSignupToken({ slug, region?, planId?, ttlSeconds? })` (CLI `signup-issue`) mints a one-time, expiring **invite token** scoped to a desired tenant; `tf.redeemSignupToken(token)` (CLI `signup-redeem`) validates it and **provisions** that tenant — the self-serve "signup" lifecycle stage Neon leaves to the builder (it provisions projects, not customers). Call `redeemSignupToken` from your own authenticated signup handler. Only the token's **SHA-256 hash** is stored (`tf_signup_tokens`, migration 0008) — the raw token is returned **once** and never persisted or logged (treat it like a credential); redemption is **single-use** and fails closed on an unknown/expired/already-redeemed token. The pure core `assertRedeemable` / `signupTokenStatus` decide redeemability (100%). Enable with `TENANTFORGE_SIGNUP_TOKEN_STORE=memory|pg`. Issuing/redeeming provision resources, so they're **CLI/library only** (never HTTP/MCP); `GET /v1/signup-tokens` + the dashboard "Signup tokens" panel show **status only** (never the token), read-only.

**Data export (portability / DSAR):** `tf.exportTenantData(id)` (CLI `export-tenant`) exports a tenant's data to durable storage via the configured `TenantExporter` and returns a reference (object-store `location` + size) — the GDPR **Art. 20 data-portability** / data-subject-request path. Unlike offboard/erase it **changes no state and deletes nothing**: the tenant stays active and gets a copy. Records a `tenant.exported` audit event (the artifact reference, never the data). Reads tenant data, so it's **CLI/library only** (never HTTP/MCP); read-only history at `GET /v1/exports` + the dashboard "Data exports" panel. Requires an exporter (`TENANTFORGE_EXPORTER`). Builder-side — Neon doesn't map customers to data or handle DSARs.

**Retention report:** `tf.retentionReport({ retentionDays?, now? })` (CLI `retention-report`, HTTP `GET /v1/retention`, dashboard "Retention" panel) is the read-only preview of the purge pipeline — which archived (`offboarding`) tenants are scheduled for deletion and when, given the retention window (`TENANTFORGE_RETENTION_DAYS`). The pure core `buildRetentionReport` computes per-tenant `purgeEligibleAt` + eligibility (reusing `isPurgeable`, so it matches `purge-expired` exactly; 100%), sorted eligible-first. Read-only everywhere (purging is the gated CLI/library sweep). Builder-side — the operator's data-retention policy is not a Neon concept.

**Compliance report:** `tf.complianceReport()` (CLI `compliance-report`, HTTP `GET
/v1/compliance/report`) emits a registry-derived **isolation + residency attestation** with a
SHA-256 integrity digest — flags shared/missing tenant projects and out-of-allow-list regions; CLI
exits non-zero on a violation (cron/CI gate). Evidence, not legal certification. With a **persisted
audit trail** (`TENANTFORGE_AUDIT_LOG=pg`; the `AuditLogStore` port + `tf_audit_log`) the report also
attests **erasure history** (tenant deletions, with operator attribution) and a **recent audit
excerpt** — the durable, queryable record behind the ephemeral stdout event stream.

**Audit explorer:** `tf.queryAudit({ events?, tenantId?, since?, limit? })` (CLI `audit`, HTTP `GET /v1/audit?event=&tenant=&since=&limit=`, dashboard "Audit log" panel) is the general, filterable view over that operator-attributed, append-only trail — filter by event name(s), tenant, and a `since` lower bound, newest-first and bounded. The pure core `normalizeAuditQuery` validates + clamps the (untrusted) filter (100%); the narrow `*History` methods (`chargeHistory`, `planChangeHistory`, …) are conveniences over it. Read-only and already-redacted (`tenant:read`). This is **your control-plane trail** (who provisioned/charged/migrated what, when) — Neon has no record of it; it's builder-side audit for NIST AU / SOC2 / OWASP A09.

**Audit anomaly detection:** `tf.scanAuditAnomalies({ since?, limit?, thresholds? })` (CLI `audit-scan`, HTTP `GET /v1/audit/anomalies`, dashboard "Audit log" panel) reads a recent window of the trail and flags an overall **error spike** plus **per-actor** and **per-tenant** error clusters — control-plane **detection** (std-mitre-attack / topic-logging-observability: alert on error bursts + repeated failures). The pure core `detectAuditAnomalies` computes the findings deterministically (100%); thresholds default to 10 / 5 / 5 and are overridable. Read-only; `audit-scan` exits non-zero on findings so a cron/CI security gate can alert. Builder-side — Neon monitors the database, not the operator's control-plane operations.

**Cost / margin:** `tf.costReport(period)` (CLI `cost-report`, HTTP `GET /v1/cost/report`, dashboard panel) estimates each tenant's Neon cost (from `TENANTFORGE_COST_RATES`) vs. its price (`metadata.priceUsd`) and flags unprofitable/unpriced tenants — a read-only **cost-attribution estimate**, not an invoice.

**Cost anomaly detection (FinOps):** `tf.scanCostAnomalies(period, thresholds?)` (CLI `cost-scan`, HTTP `GET /v1/cost/anomalies`, dashboard cost panel) scans that report and surfaces the tenants needing attention — **unprofitable** (cost > price) and **unpriced-but-consuming** always, plus opt-in **thin-margin** (`min-margin`) and **high-cost** (`max-cost`) flags, most-severe first. The pure core `detectCostAnomalies` classifies each row deterministically (one finding per tenant, 100%). Read-only; `cost-scan` exits non-zero on findings so a cron/CI FinOps gate can alert. Builder-side — Neon has no notion of the operator's prices or margins (not a Neon feature).

**Operator alert digest (single pane):** `tf.operatorDigest({ period?, notify? })` (CLI `operator-digest [--json] [--notify]`, HTTP `GET /v1/operator/digest`, MCP `tf_operator_digest`, dashboard **Health** panel — the default landing) rolls **all five detectors** — audit anomalies, cost anomalies, fleet drift, retention backlog, usage alerts — into one operational-health summary with an **overall severity** (`ok`/`info`/`warning`/`critical`). The pure core `buildOperatorDigest` classifies each category and rolls up the max deterministically (100%); gathering is **best-effort per detector** (one that can't run contributes nothing rather than failing the roll-up). It always emits an `operator.digest` event (→ JSON logs / audit store / **outbound webhooks/SIEM** — the programmatic alert hook); with `--notify` + a notifier + `TENANTFORGE_OPERATOR_EMAIL` it also emails the digest for a non-`ok` severity (best-effort). `operator-digest` exits non-zero on any non-`ok` severity so a cron/CI health gate can alert. Builder-side — the single pane of _your_ control-plane health, which Neon has no view of.

**Invoices:** `tf.invoice(id, period)` / `invoiceFleet(period)` (CLI `invoice` / `invoice-fleet`, HTTP `GET /v1/tenants/:id/invoice` + `GET /v1/invoices`, dashboard panel) generate per-tenant **invoice documents** — usage billed at your **billing (sell) rates** (`TENANTFORGE_BILLING_RATES`) plus the flat plan fee (`metadata.priceUsd`), as line items + total. These are billable **artifacts**; to actually charge them, see Charging below.

**Plan catalog (named tiers):** define your product plans once in `TENANTFORGE_PLANS` (a JSON array of `{ id, name?, priceUsd?, includedUsage? }`, validated at load by the pure `assertPlanCatalog`, 100%); `tf.listPlans()` (CLI `plans`, HTTP `GET /v1/plans`, dashboard panel) publishes the catalog read-only. `tf.assignPlan(tenantId, planId)` (CLI `assign-plan`) sets a tenant's **price + included allowances + `metadata.planId`** to exactly what the plan defines in one step (the plan _fully defines_ the tenant's billing — a no-allowance plan clears prior overrides). This is **builder-only product knowledge** — Neon provisions per project and has no concept of your pricing tiers. Assigning is a billing-policy metadata change, so it's **CLI-only** (never HTTP/MCP), and it does **not** settle proration — use `changePlan` with `settle` for that.

**Included allowances (overage billing):** `tf.setIncludedUsage(id, allowance)` (CLI `set-allowance`) sets a tenant's per-period **included usage** (`metadata.includedUsage` — compute-seconds, active-seconds, peak-storage bytes, written bytes). Usage **within** an allowance is free; only the **overage** is billed (at your billing rates), as a labelled line item (`Compute time (overage; N incl.)`) — so invoices and charges automatically bill only the excess. The pure core `applyIncludedAllowance` computes `max(0, used − allowance)` per dimension (100%). An allowance is a **billing free-tier**, distinct from a `Quota` (a hard enforcement limit that suspends). Setting allowances is a billing-policy metadata change, so it's **CLI-only** (never HTTP/MCP); the resulting overage is visible read-only in `GET /v1/tenants/:id/invoice`, `GET /v1/invoices`, and the dashboard invoices panel. Pass `--clear` to bill from the first unit again.

**Usage alerts (approaching allowance):** `tf.checkUsageAlerts(period, { notify? })` (CLI `usage-alerts [--notify]`) sweeps active tenants and flags those that have crossed a configured fraction of their plan's included allowance — thresholds set via `TENANTFORGE_USAGE_ALERT_THRESHOLDS` (e.g. `0.8,1.0` = 80% / 100%). The pure core `evaluateUsageAlerts` finds the highest crossed threshold per metered dimension (100%). Each alerted tenant emits a `tenant.usage_alert` event (fanned to any outbound webhook — billing/CRM/alerting); with `--notify` and a notifier wired, it also emails the tenant's `metadata.billingEmail` (best-effort; the recipient is never recorded in the audit trail — PII). This is **not a Neon feature**: it consumes Neon's consumption metering (via the existing `UsageProvider`) and layers _your_ per-tenant plan-allowance + threshold policy on top — concepts Neon has no knowledge of. The live sweep is library/CLI (it emits + may notify); HTTP `GET /v1/usage-alerts` and the dashboard show alert **history** read-only.

**Invoice delivery (email):** `tf.sendInvoice(id, period)` / `sendInvoiceFleet(period)` (CLI `send-invoice` / `send-invoice-fleet`) generate a tenant's invoice and **email** it to `metadata.billingEmail` via the configured notifier. The pure core `renderInvoiceEmail` builds the subject + body (100%); sends are **de-duplicated per tenant + period** (`invoiceEmailIdempotencyKey`) so a re-run never double-emails, and a tenant with no billing email is skipped (not failed). An outward send (not money), so it's **CLI/library only** (never HTTP/MCP); the recipient address is never recorded — a redacted `tenant.invoiced` event is. Read-only delivery history at `GET /v1/billing/invoices-sent` + the dashboard billing panel. Requires a usage provider **and** a notifier.

**Charging (PSP):** `tf.chargeInvoice(id, period)` / `chargeInvoiceFleet(period)` (CLI `charge` / `charge-fleet`, **`--yes`-gated**) charge a tenant's invoice via the configured gateway behind the swappable **`PaymentGateway` port** — **Stripe** ships (REST + injectable `fetch`, zero SDK dep); plug in any other PSP/billing agent the same way. Money is integer minor units; charges are **idempotent** (no double-bill); the tenant's PSP customer id is `metadata.billingCustomerRef`. Opt-in via `TENANTFORGE_PAYMENT_GATEWAY=stripe` + `STRIPE_SECRET_KEY`. **Charging is CLI-only and gated — never over HTTP or MCP** (money movement, LLM08); HTTP `GET /v1/billing/charges` + the dashboard billing panel show **read-only** charge history.

**Inbound PSP webhooks:** `POST /webhooks/payment` ingests payment events (Stripe `payment_intent.succeeded` / `payment_failed` / `charge.refunded`) behind the swappable **`PaymentWebhookVerifier` port** — authenticated by the **signature** (HMAC over the raw body, constant-time, replay-checked), **not** the bearer token, so it lives outside `/v1`. Verified events become redacted `payment.webhook` audit records (charges stamp `metadata.tenant_id` so events correlate back to the tenant); read them via `GET /v1/billing/webhook-events` + the dashboard billing panel. Enable with `TENANTFORGE_PAYMENT_WEBHOOK_SECRET`.

**Dunning (failed-charge retry):** `tf.runDunning(period?, schedule?)` (CLI `dunning`, **`--yes`-gated**) sweeps active tenants, derives each one's consecutive-failure count + backoff from the `tenant.charged` audit trail, and decides — **retry** the charge now, **wait** (within backoff / not failing), or **suspend** (retries exhausted, a reversible escalation). Retries use a **per-attempt idempotency key** (`…:retry-N`) so the PSP makes a _fresh_ attempt rather than replaying the original failure. Failure-isolated, idempotent, and audit-derived (no extra state); each action emits a redacted `tenant.dunning` event. Default schedule: 4 attempts, ≥24h apart (`--max-attempts` / `--min-hours`). **CLI-only and gated — never over HTTP or MCP** (it moves money and suspends tenants, LLM08); HTTP `GET /v1/billing/dunning` + the dashboard billing panel show **read-only** dunning history.

**Scheduled billing run:** `tf.billingRun(period?, opts?)` (CLI `billing-run`, **`--yes`-gated**) is the unattended capstone — it **charges the fleet, then runs the dunning sweep** in one pass, so billing operates from a cron / K8s CronJob (like `purge-expired`) instead of by hand. Idempotent (charges de-dupe; dunning re-derives from the audit trail), so a scheduler double-fire is safe; `--skip-dunning` for a charge-only run. Emits a roll-up `billing.run` audit event (the per-tenant charge/dunning events come from the sweeps). **CLI-only and gated — never over HTTP or MCP**; read-only run history at `GET /v1/billing/runs` + the dashboard billing panel. Procedure: [`docs/runbooks/billing-run.md`](./docs/runbooks/billing-run.md).

**Refunds / credits:** `tf.refundCharge(chargeId, opts?)` (CLI `refund`, **`--yes`-gated**) reverses a charge **fully or partially** through the same swappable `PaymentGateway` port (`refund()` — Stripe ships; any PSP implements it the same way). It looks the charge up in the `tenant.charged` audit trail to recover the **currency / original amount / tenant** (so a full refund resolves correctly and a partial is bounded — you can't refund more than was charged; pass `currency` explicitly for a charge that predates the audit store). **Idempotent** on a per-charge+amount key (`tenantforge:refund:{chargeId}:{full|amount}`) so a retry never double-refunds; emits a redacted `tenant.refunded` event (refund id, amount, status — no card data). **CLI-only and gated — never over HTTP or MCP** (it returns real money, LLM08); read-only history at `GET /v1/billing/refunds` + the dashboard billing panel.

**Refund on offboard (proration):** `tf.refundUnusedPeriod(id, { asOf?, reason? })` refunds the **unused portion** of a tenant's latest charge when it leaves mid-period — `prorateRefundMinor` computes `round(amount × (periodEnd − asOf) / (periodEnd − periodStart))` (pure, 100%-covered: offboard at/before the period start → full refund; at/after the end → nothing). It derives the charge id / amount / period from the most recent `tenant.charged` event (the charge event now stamps its period) and issues the prorated refund through `refundCharge` (so it inherits idempotency + the `tenant.refunded` audit + the refunds panel). Surfaced as `offboard <id> --refund --yes` — the refund stays a **separate, explicitly-gated step** so plain `offboard` (on HTTP/MCP) never moves money. **Proration policy is unused-time, rounded to the minor unit;** other policies (none / full / fixed credit) can wrap the same primitive.

**Plan management (upgrade/downgrade with proration):** `tf.changePlan(id, newPriceUsd, { settle? })` (CLI `plan-change`) updates a tenant's flat plan price (`metadata.priceUsd`) and, with `--settle`, settles the **prorated delta** for the remaining period — `proratePlanChangeMinor` computes `round(f × (newPrice − oldPrice))` (pure, 100%): **positive ⇒ charge** (upgrade), **negative ⇒ credit** (downgrade — see the credit ledger below; **uncapped**), zero ⇒ none. Preview the quote first with `previewPlanChange` / HTTP `GET /v1/tenants/:id/plan/preview?price=N` (read-only, no mutation). Settlement moves money, so `--settle` is **`--yes` gated and CLI-only** (never HTTP/MCP); the price update itself always applies and emits a `tenant.plan_changed` event. Read-only history at `GET /v1/billing/plan-changes` + the dashboard billing panel.

**Credit ledger:** an authoritative per-tenant **credit balance** (`TENANTFORGE_CREDIT_LEDGER=memory|pg`, behind the `CreditLedger` port — `pg` is durable + cross-instance via `tf_credits`). Credits are **granted** (`tf.grantCredit` / CLI `credit-grant`, `--yes` gated — a downgrade proration grants the **full, uncapped** credit here instead of a refund capped at the last charge; also operator goodwill) and **consumed** automatically: a charge **draws down the balance first** and only bills the remainder to the card (skipping the PSP entirely when credit covers the whole invoice). Consumption is **idempotent per billing period** (a dunning retry never double-spends) and balance reads/writes are atomic (a per-tenant advisory lock in the pg adapter). Read-only balance + ledger at `GET /v1/tenants/:id/credit`; recent grants on the dashboard. When no ledger is configured, a downgrade falls back to the legacy capped refund.

**Receipts / notifications:** a successful charge or refund **best-effort** sends a receipt to the tenant's `metadata.billingEmail`, behind the swappable **`Notifier` port**. Env-selectable: `log` (default — records an auditable receipt trail, no external send) or `http` (POST each receipt to a relay over https, optionally HMAC-signed, zero-dep via injectable `fetch`). **Real email** ships too — **`createSesNotifier`** (AWS SES) and **`createSmtpNotifier`** (any SMTP / nodemailer) take a minimal **injected client/transport** so the SDK isn't a dependency here (the same hand-wired pattern as the AWS Secrets Manager / S3 adapters; wire via `createTenantForge({ notifier })`). Configure SPF/DKIM/DMARC on the sending domain for deliverability. The receipt body is rendered in the **pure core** (`renderReceipt`, 100%) and carries only safe fields (amount, currency, reference, date) — **no card data, and the recipient address is never written to the audit trail** (PII, master §5). Idempotent on `tenantforge:receipt:{kind}:{reference}` so a retry never double-notifies; a send failure **never breaks the charge/refund** it confirms. Enable with `TENANTFORGE_NOTIFIER=log|http` (+ `TENANTFORGE_NOTIFIER_URL` for http). Read-only history at `GET /v1/billing/notifications` + the dashboard billing panel; **not on MCP**.

**Web dashboard:** a React/Vite SPA (`dashboard/`) gives operators a browser view of the control
plane, organized into deep-linkable sections — **Fleet** (compliance, drift, reconcile), **Billing**
(cost, plans, invoices, charges, signup tokens), and **Audit** (log + anomalies) — reachable via a
tab nav (`#/fleet` · `#/billing` · `#/audit`). It logs in with an operator token exchanged for an
**HttpOnly session cookie** by the `/dashboard` backend (mounted when `TENANTFORGE_DASHBOARD_SECRET`
is set), then reads `/dashboard/api/*`. The UI is **responsive (mobile-first)** with a card-based
layout and **light/dark themes** (follows `prefers-color-scheme` by default, with a persisted
in-app toggle). **Accessibility-first / WCAG 2.2 AA**: semantic landmarks + skip link, keyboard
operability with visible focus, focus moved to `main` on section change, `prefers-reduced-motion`
honored, and sufficient contrast in both themes — enforced by jsx-a11y lint + axe tests (run per
section). Token-based hand-rolled CSS, **zero external style deps** (CSP-safe). Dev: `pnpm dashboard:dev` (tailnet-only — loopback by
default, `DASHBOARD_HOST` for a Tailscale IP; never public). In **production**, set
`TENANTFORGE_DASHBOARD_DIST=./dashboard/dist` (after `pnpm dashboard:build`) and the control-plane
server serves the built SPA under `/dashboard` itself — no separate web server. The CLI/HTTP/MCP
surfaces remain the automation path; the dashboard is the human window onto each feature.

**Tenant self-serve portal:** a **customer-facing** web view (`/portal`, distinct from the operator dashboard) where a **tenant sees only its own** account, **usage** (this period's metered consumption), charges, refunds, and **receipts**. A tenant signs in behind the swappable `TenantAuthenticator` port — either a **static token** (`TENANTFORGE_PORTAL_CREDENTIALS=tenantId:token,…`) or, for production, **OIDC** (`TENANTFORGE_PORTAL_AUTH_MODE=oidc` — verify a customer-IdP JWT against its JWKS, tenant id read from a claim, with the same pinned-asymmetric-alg / `iss`/`aud`/`exp` checks as the operator OIDC) — exchanged for an **HttpOnly, `SameSite=Strict` session cookie**; **the tenant id comes only from that server-side session and is never read from request input**, so a tenant can't reach another tenant's data (no BOLA — `std-owasp-api` API1, the project's #1 boundary). Reads go through tenant-scoped facade methods (`tenantSummary` returns a **safe projection** — no raw metadata / `billingCustomerRef` / infra ids; `tenantCharges`/`tenantRefunds`/`tenantNotifications` are store-filtered by tenant; usage is shown without the internal Neon project id). **Read-only** — no money movement or lifecycle actions (those stay operator/CLI). Server-rendered semantic HTML (WCAG 2.2 AA) with no external resources, plus JSON `/portal/api/*` for automation. Mounted when `TENANTFORGE_PORTAL_SECRET` + a tenant authenticator (token credentials or OIDC config) are set. A cross-tenant-isolation test is part of the suite.

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
