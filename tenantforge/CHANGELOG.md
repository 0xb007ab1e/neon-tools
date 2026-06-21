# Changelog

All notable changes to TenantForge are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.10.0] - 2026-06-21

Completes the money flow with its reverse: charges can now be **refunded** (fully or partially)
through the same swappable gateway port — the safety complement to unattended billing. Additive/
backward-compatible (MINOR); the operation is opt-in, CLI-only, and `--yes` gated.

### Added

- **Refunds / credits** — `tf.refundCharge(chargeId, opts?)` (CLI `refund`, `--yes` gated) reverses a
  charge **fully or partially** through the `PaymentGateway` port, which gains a **`refund()`** method
  (Stripe adapter implements it via `POST /v1/refunds`; the free-text reason rides in metadata since
  Stripe's `reason` is a fixed enum). The facade looks the charge up in the `tenant.charged` audit
  trail to recover currency / original amount / tenant (full refund resolves correctly; a partial is
  bounded — `assertRefundAmount` rejects refunding more than was charged); pass `currency` explicitly
  for a pre-audit charge. **Idempotent** on `refundIdempotencyKey(chargeId, amount?)`
  (`tenantforge:refund:{chargeId}:{full|amount}`) so a retry never double-refunds; emits a redacted
  `tenant.refunded` event (refund id, amount, status — no card data); `refundHistory()` reads them
  back. **CLI-only and gated — never over HTTP or MCP** (`std-owasp-llm` LLM08); read-only history at
  `GET /v1/billing/refunds` + the dashboard billing panel + OpenAPI. The `billing-run` runbook's
  abort path now points at `refund` instead of an out-of-band PSP step. Pure core (`assertRefundAmount`
  / `refundIdempotencyKey`) at 100%; covered by the Stripe adapter (full / partial / pending /
  failed / non-2xx), facade (audit-derived, partial bound, explicit-currency, idempotency, error
  path, history), HTTP, dashboard, and OpenAPI tests.

## [0.9.0] - 2026-06-21

Makes billing **operate unattended**. The charge → dunning loop, manual until now, is wrapped into a
single scheduled **billing run** for a cron / K8s CronJob — the capstone of the billing arc.
Additive/backward-compatible (MINOR); the run is opt-in, CLI-only, and `--yes` gated.

### Added

- **Scheduled billing run** — `tf.billingRun(period?, opts?)` (CLI `billing-run`, `--yes` gated) is
  the unattended capstone of the billing arc: it **charges the fleet, then runs the dunning sweep**
  in one pass, so billing runs from a cron / K8s CronJob (like `purge-expired`) instead of by hand.
  Composes the existing fleet-charge + dunning logic (extracted into shared closures, no behavior
  change to `chargeInvoiceFleet`/`runDunning`); **idempotent** (charges de-dupe on the stable
  per-period key, dunning re-derives state from the audit trail) so a scheduler double-fire is safe,
  and failure-isolated. `--skip-dunning` for a charge-only run; `--max-attempts`/`--min-hours` tune
  the dunning policy. Emits a roll-up `billing.run` audit event (the per-tenant `tenant.charged` /
  `tenant.dunning` events still come from the sweeps); `billingRunHistory()` reads them back.
  **CLI-only and gated — never over HTTP or MCP** (`std-owasp-llm` LLM08); read-only history at
  `GET /v1/billing/runs` + the dashboard billing panel + OpenAPI. New
  [`docs/runbooks/billing-run.md`](./docs/runbooks/billing-run.md). Covered by facade (compose,
  skip-dunning, gateway-required, roll-up event, defaults), HTTP, dashboard, and OpenAPI tests.

## [0.8.0] - 2026-06-21

Closes the billing lifecycle and hardens the wire. **Dunning** turns a one-off failed charge into a
managed retry-then-escalate sweep (the missing half of charging), and a **project-wide TLS
enforcement** pass makes every outbound connection fail closed on plaintext, with the whole network
surface — including each intentionally-open endpoint — now documented. Additive/backward-compatible
(MINOR); the TLS change is default-secure (a real Neon URL + the default https endpoints pass
unchanged), erroring only on a previously-misconfigured plaintext target.

### Security

- **Project-wide TLS/mTLS enforcement** — every outbound connection now fails closed at startup
  unless it negotiates TLS, with a pure, 100%-covered guard pair in
  `src/core/transport-security.ts`: `assertPostgresTls` (connection string must carry
  `sslmode=require`/`verify-ca`/`verify-full`) and `assertHttpsUrl` (URL must be `https://`). Wired
  into **all** network adapters — the Postgres registry, encrypted secret store, message queue,
  rate-limit / idempotency / audit stores, per-tenant migration runner, and `pg_dump`/`pg_restore`
  (Postgres); and the Neon API (usage/provisioning/snapshot), HashiCorp Vault, Azure Key Vault, OIDC
  JWKS fetch, and the Stripe gateway base URL (https). Cloud SDK adapters already enforce TLS via
  their SDK. Two explicit, default-`false` opt-outs (`TENANTFORGE_ALLOW_INSECURE_DB`,
  `TENANTFORGE_ALLOW_INSECURE_URLS`) exist for local dev against a certificate-less loopback service
  — the documented "leaky endpoints." A new **README "Security: TLS & network surface"** section
  documents the enforcement, the proxy-terminates-TLS inbound contract (dev = tailnet-only, never
  public), and every intentionally-unauthenticated endpoint (`/health`, `/ready`, `/metrics`,
  signature-authed `POST /webhooks/payment`) with its risk. Covered by core guards (100%) +
  adapter fail-closed tests.

### Added

- **Dunning / failed-charge retry** — a fleet sweep that retries past-due charges and escalates the
  hopeless, behind a pure decision core. `planDunning(consecutiveFailures, hoursSinceLastAttempt,
schedule)` decides **retry** / **wait** / **suspend**; `dunningStateFromCharges` derives the
  consecutive-failure count + backoff window from the persisted `tenant.charged` audit trail (no new
  migration — state is audit-derived, like reconcile/compliance). The critical correctness fix:
  retries use a **per-attempt idempotency key** (`chargeIdempotencyKey(invoice, attempt)` →
  `…:retry-N`) so the PSP makes a **fresh** attempt instead of replaying the original failure, while
  the base charge keeps its stable key (accidental double-calls still de-dupe). Facade
  `runDunning(period?, schedule?)` is failure-isolated + idempotent, suspends the exhausted
  (reversible escalation via the lifecycle state machine), and emits a redacted `tenant.dunning`
  event per action; `dunningHistory()` reads them back. Surfaces: CLI **`dunning`** (`--yes` gated —
  it moves money and may suspend; `--from/--to/--max-attempts/--min-hours`), read-only history on
  HTTP (`GET /v1/billing/dunning`) and the dashboard billing panel. **Deliberately NOT on MCP** (the
  run moves money + suspends — gated, off the agent surface; `std-owasp-llm` LLM08). Default schedule:
  4 attempts, ≥24h backoff. Covered by the pure core at 100% (decision matrix, failure-run counting,
  bad-timestamp guard), facade (retry/suspend/skip routing, per-attempt key, decline isolation,
  defaults), HTTP, dashboard, and OpenAPI contract tests.

## [0.7.0] - 2026-06-21

Makes the billing surface **bidirectional**: TenantForge now both charges (0.6.0) and **ingests the
PSP's webhooks** about those charges, behind a swappable verifier port. Additive/backward-compatible
(MINOR); the endpoint is opt-in, signature-authed, and off by default.

### Added

- **Inbound PSP webhook ingestion** — receive payment events (e.g. Stripe `payment_intent.succeeded`
  / `payment_failed` / `charge.refunded`) behind a swappable **`PaymentWebhookVerifier` port** (the
  inbound counterpart to the `PaymentGateway` port). The **Stripe adapter** verifies the
  `Stripe-Signature` over the **raw body** (HMAC-SHA256, **constant-time** compare) and **replay-checks
  the timestamp** (`topic-webhooks`), then parses + normalizes the (untrusted, schema-validated)
  payload to a PSP-agnostic `PaymentEvent`. Charges now stamp `metadata.tenant_id` so events
  correlate back to the tenant. Facade `ingestPaymentWebhook(rawBody, signature)` emits a redacted
  `payment.webhook` audit event (attributed to the tenant; failed-charge events as `outcome: error`);
  `paymentWebhookHistory()` reads them back. The endpoint is **`POST /webhooks/payment`** —
  authenticated by the **signature, not the bearer token**, so it sits outside `/v1`; body-size-capped,
  fails 400 without leaking why, mounted only when `TENANTFORGE_PAYMENT_WEBHOOK_SECRET` is set.
  Read-only history on HTTP (`GET /v1/billing/webhook-events`) + the dashboard billing panel. Covered
  by the Stripe verifier (valid / bad-sig / tampered-body / stale-timestamp / malformed / type-mapping),
  facade (verify+audit+attribute, fail-closed, failed→error, history), HTTP (signature-authed ingest,
  bad-sig 400, not-mounted 404, read history), and dashboard (axe) tests.

## [0.6.0] - 2026-06-21

Closes the billing loop: invoice documents can now become **real charges** via a swappable
`PaymentGateway` port (Stripe ships). This completes the extend-Neon arc end-to-end — provision →
route → lifecycle → migrate/reconcile → compliance → cost → invoice → **charge** — each across
library/CLI/HTTP/MCP + dashboard. Additive and backward-compatible (MINOR); charging is opt-in,
CLI-only + gated, and disabled by default.

### Added

- **Payment-gateway (PSP) charging** — turn invoice documents into real charges, behind a swappable
  **`PaymentGateway` port** (one seam; swap Stripe for Adyen / Braintree / a custom billing agent
  without touching the control plane). A **Stripe adapter** speaks the REST API via injectable
  `fetch` (zero SDK dependency, like the Vault / Azure-Key-Vault adapters): a confirmed, off-session
  PaymentIntent against the customer's saved method, with the **idempotency key on the
  `Idempotency-Key` header** so a retry never double-bills. Money is computed in the pure core
  (`invoiceChargeAmount` / `chargeIdempotencyKey`, 100%): **integer minor units, never floats**, and
  a zero/negative total fails closed. Facade `chargeInvoice(id, period)` + `chargeInvoiceFleet(period)`
  (failure-isolated billing run — skips tenants with no `metadata.billingCustomerRef` or a zero
  invoice) emit a redacted `tenant.charged` audit event (amount/status/charge id — **no card data**);
  `chargeHistory()` reads them back. **Safety posture (workflow-gated-actions / std-owasp-llm LLM08):**
  charging is **CLI-only and `--yes`-gated** (`charge` / `charge-fleet`) — **never** exposed over HTTP
  or MCP; HTTP + the dashboard expose **read-only** charge history (`GET /v1/billing/charges`, billing
  panel). Opt-in via `TENANTFORGE_PAYMENT_GATEWAY=stripe` + `STRIPE_SECRET_KEY` (fails closed
  otherwise; the key is never logged). Covered by core (100%), the Stripe adapter (success / processing
  / requires-action / decline / non-2xx, idempotency-key + amount encoding), facade (charge / no-gateway
  / no-ref / zero-amount / fleet isolation / history), HTTP, and dashboard (axe) tests.

## [0.5.0] - 2026-06-21

Brings the 0.4.x extension features to the **agent (MCP) surface**, completing
library/CLI/HTTP/MCP parity across compliance, cost/margin, invoices, and fleet reconcile. Additive
and backward-compatible (MINOR); read-only and secret-free on the agent surface, with reconcile
execution deliberately kept off it (LLM08).

### Added

- **MCP parity for the extension reports** — the agent surface gains read-only tools for the 0.4.0
  features: `tf_compliance_report`, `tf_cost_report`, `tf_invoice` / `tf_invoices`, `tf_reconcile_plan`,
  and `tf_reconcile_history` (cost/invoice take optional ISO `from`/`to`, defaulting to the current
  month; bad dates fail closed with a clear message). **Agent-safety (std-owasp-llm LLM08):** these
  are read-only and secret-free, and fleet reconcile is exposed **plan/history only** — execution
  stays on the CLI / gated dashboard, alongside the already-excluded purge. Covered by MCP tests
  (surface list, period pass-through, bad-date fail-closed, reconcile read-only, execution absent).

## [0.4.1] - 2026-06-21

Docs/tooling patch — no functional changes. Syncs the collection index and adds a guard so the
version can't drift again.

### Changed

- **Synced the collection index (`../TOOLS.md`)** — TenantForge's status was stale at `alpha`; now
  `stable`, with the summary + `Provides` refreshed to cover the 0.4.0 capabilities (drift
  reconciliation, compliance, cost/margin, invoicing, web dashboard).

### Added

- **README shields version badge** under the title (linked to the release).
- **Version-consistency CI gate** (`scripts/check-version.mjs`, run via `pnpm -r --if-present
version:check` in the `quality` job) — asserts the version is identical across `package.json`
  (source of truth), `neon-tool.json`, `src/meta.ts`, `openapi.yaml`, and the README Status line +
  badge; CI fails on any drift.

## [0.4.0] - 2026-06-20

The **Neon-extension** release. TenantForge repositions from re-implementing Neon primitives to
**extending** them with the builder-only layer Neon leaves open: a **compliance report** (isolation +
residency attestation, with an audit-backed erasure history once a persisted audit trail is wired), a
**cost / margin** attribution report, and **fleet drift reconciliation** (bring behind/failed tenants
to a target version, ordered + failure-isolated + idempotent, with history). It also ships a
**web dashboard** (React/Vite SPA + cookie-session backend) surfacing every feature — including a
`tenant:provision`-gated "Run reconcile" action — plus **invoice generation** (usage billed at sell
rates → documents, not charges), a persisted **`AuditLogStore`**, production SPA serving, and React/
a11y lint coverage. All changes are additive and backward-compatible (MINOR). Core stays 100%; the
full suite (572 control-plane + 3 dashboard tests) is green.

### Added

- **Reconcile history (audit-backed)** — surfaces the persisted `fleet.reconcile` events as a
  queryable run log: who reconciled the fleet, when, to which target, and with what outcome.
  `TenantForge.reconcileHistory(limit?)` reads them from the audit trail (HTTP `GET
/v1/fleet/reconcile/history`, dashboard reconcile panel "recent runs" table). Degrades gracefully —
  returns `[]` when no audit store is wired (`TENANTFORGE_AUDIT_LOG=pg` persists the trail). Covered
  by facade (records a run → reads it back; `[]` without a store), HTTP, and dashboard (axe) tests.

- **Invoice generation (usage-based billing documents)** — turn metered usage into per-tenant
  **invoice documents**: the pure `buildInvoice` (core, 100%) bills each tenant's consumption at the
  operator's **billing (sell) rates** (`TENANTFORGE_BILLING_RATES`, distinct from the wholesale
  `TENANTFORGE_COST_RATES`) plus a flat plan fee (tenant `metadata.priceUsd`), producing line items +
  total. New `InvoiceEngine` + facade `invoice(id, period)` / `invoiceFleet(period)` (failure-
  isolated), CLI `invoice` / `invoice-fleet`, HTTP `GET /v1/tenants/:id/invoice` + `GET /v1/invoices`
  (`tenant:read`), and a **dashboard invoices panel**. **Scope/honesty:** this produces billable
  **artifacts** (amounts rounded to cents) — it does **not** charge a card; wiring the total into
  Stripe/a PSP is a separate, credential-bearing integration left to the operator. Covered by core,
  engine (meter + plan fee, unknown/unprovisioned, failure-isolated fleet), facade, HTTP, and
  dashboard (axe) tests.

- **Dashboard-initiated fleet reconcile (gated mutating action)** — execute a reconcile from the
  browser, not just preview it. When the server is configured with a migration catalog
  (`TENANTFORGE_MIGRATIONS_DIR`, loaded at startup), the dashboard exposes a **`tenant:provision`-
  gated** `POST /dashboard/api/reconcile` (deny-by-default — readonly/unprivileged get 403; the
  `SameSite=Strict` session cookie defends CSRF; the run is audited via `fleet.reconcile`) plus a
  `GET …/reconcile/capabilities` so the SPA shows a **"Run reconcile"** button only when execution is
  wired _and_ the operator may. Clicking confirms, then POSTs and surfaces the result. Execution is
  off unless the catalog env is set (preview-only otherwise — the server has no SQL to apply).
  Covered by dashboard backend tests (capabilities, execute-as-admin, **403 readonly**, 401 no
  session, **409 no catalog**) and an SPA run-flow test (confirm → POST → result; button hidden when
  not executable).

- **Fleet drift reconciliation** (`docs/research/pivot-directions.md` #2) — the actuator that turns
  the read-only drift report into action: bring every behind/failed active tenant up to a target
  catalog version. The pure `planFleetReconcile` (core, 100%) computes each tenant's **ordered
  missing versions** up to the target; the orchestrator's `reconcileFleet` applies them **in order,
  stopping at a tenant's first failure** (a later migration must never run before an earlier one
  succeeds — unlike `migrateFleet`, which applies one version fleet-wide), failure-isolated,
  idempotent/resumable, with an optional **canary** (abort the fleet if it fails). Surfaces:
  `TenantForge.reconcileFleet(catalog, opts)` + CLI `reconcile-fleet <migrations-dir>` execute (need
  the SQL catalog); `reconcilePlan()` / `reconcile-fleet --plan` / HTTP `GET /v1/fleet/reconcile`
  (`tenant:read`) / a **dashboard reconcile panel** preview the plan read-only (no SQL needed).
  Covered by core, orchestrator (ordered apply, stop-on-failure, isolation, canary-abort, idempotent
  skip, checksum-drift), facade, HTTP, and dashboard (axe) tests.

- **Production SPA serving from the control-plane server** — the dashboard backend can now also serve
  the **built front-end** (`dashboard/dist`), so a production deploy needs no separate static web
  server. Set `TENANTFORGE_DASHBOARD_DIST` (alongside `TENANTFORGE_DASHBOARD_SECRET`) and the server
  serves `index.html` + hashed assets under `/dashboard`, with **SPA fallback** to `index.html` for
  unknown sub-paths — registered **after** the `/api` routes so it never shadows them. The Vite
  `base` is now `/dashboard/` (the app is served under that path in dev and prod alike); the built
  SPA ships in the package `files`. Static serving is opt-in (unset = JSON API only, SPA served by
  Vite in dev). Covered by tests (index, hashed asset, SPA fallback, API-not-shadowed, API-only mode).

- **React/a11y lint coverage for the dashboard SPA** — `dashboard/` is no longer eslint-ignored; a
  dedicated flat-config block lints it with **eslint-plugin-react** + **react-hooks** (rules-of-hooks
  and exhaustive-deps as errors) + **eslint-plugin-jsx-a11y** (recommended) on top of the
  type-checked base. a11y is a non-negotiable mandate (master §1), so accessibility is now enforced
  at lint time, not just hand-verified + axe-tested. `npm run lint` (CI `quality`) covers the
  dashboard; no new findings (clean).

- **Persisted audit trail → erasure history + audit excerpt in the compliance report** — closes the
  follow-on the compliance report flagged. A new **`AuditLogStore`** port with an **in-memory**
  adapter (default/tests) and a **Postgres** adapter (`tf_audit_log`, migration 0006 — durable,
  queryable, cross-instance), plus `createAuditLogEventSink` which fans the existing event stream
  into the store (best-effort, never blocks/throws — the redacted events, no secrets/PII; master §5).
  Enable with `TENANTFORGE_AUDIT_LOG=pg`. When wired, `complianceReport()` attests **erasure history**
  (transitions to `deleted` — right-to-erasure evidence, with operator attribution) and a **recent
  excerpt** of control-plane activity; the pure `buildComplianceReport` maps them to a compact,
  newest-first, hashable `audit` section (core stays 100% covered; section omitted entirely when no
  store is configured). The dashboard compliance panel renders the erasure history. Covered by core,
  in-memory adapter, event-sink, facade (full lifecycle → attributed erasure), and dashboard (axe)
  tests; the pg adapter is integration/game-day-covered.

- **Per-tenant cost / margin report + dashboard panels (cost, drift)** — the second Neon-extension
  direction (`docs/research/pivot-directions.md` #3) plus dashboard backfill. The pure
  `buildCostReport` (core, 100%) estimates each tenant's Neon cost from configured unit rates
  (`TENANTFORGE_COST_RATES` JSON) vs. the operator's price (tenant `metadata.priceUsd`), flagging
  **unprofitable** and **unpriced** tenants with fleet totals — a read-only **cost-attribution**
  estimate (which tenants cost more than they pay), explicitly **not** an invoice (Neon meters; OSS
  billing engines invoice). New `CostEngine` + facade `costReport(period)`, CLI `cost-report
[--json]`, HTTP `GET /v1/cost/report` (`tenant:read`), and a **dashboard cost panel**. Failure-
  isolated: unmetered tenants are listed, not silently dropped. Also **backfilled dashboard panels**
  for **compliance**, **fleet drift** (`fleetStatus`), and cost (per the per-feature-dashboard rule)
  via `/dashboard/api/{compliance,drift,cost}`. Core + engine unit-tested; HTTP + dashboard routes +
  SPA panels (jsdom/axe) covered.

- **Web dashboard (React/Vite SPA + cookie-session backend)** — the per-feature browser dashboard
  (new project rule). **Backend** (`src/app/dashboard.ts`, mounted at `/dashboard` when
  `TENANTFORGE_DASHBOARD_SECRET` is set): a **signed, HttpOnly, `SameSite=Strict` session cookie**
  minted from an operator token (no token in browser storage; CSRF-defended; constant-time MAC,
  fail-closed on missing/tampered/expired). `POST/GET/DELETE /dashboard/api/session` (login / whoami
  / logout) reuse the API authenticator; `GET /dashboard/api/compliance` serves the report behind
  `tenant:read`. **Frontend** (`dashboard/`, Vite + React 19 + TS): token login → **compliance
  panel** (isolation / residency / inventory) as **WCAG 2.2 AA** semantic HTML (labelled form,
  table captions + scope, status by text not color alone, focus-visible). Dev server is
  **tailnet-only** (loopback by default; `DASHBOARD_HOST` for a Tailscale IP; never `0.0.0.0`/Funnel)
  and proxies `/dashboard/api` to the control-plane server. Verified: strict `tsc` + `vite build` +
  **jsdom/Testing-Library/axe** tests (login-gate + panel render, both axe-clean). _(Note: axe's
  color-contrast rule can't run under jsdom — verified by design/manual.)_ The dashboard is
  **additional** to the CLI/HTTP/MCP automation surfaces, which remain.

- **Compliance report (fleet attestation)** — first build of the Neon-extension repositioning
  (`docs/research/pivot-directions.md` #1): `TenantForge.complianceReport()` (CLI `compliance-report
[--json]`, HTTP `GET /v1/compliance/report`) emits a point-in-time, registry-derived attestation
  with a SHA-256 integrity digest. The pure `buildComplianceReport` (core, 100% covered) attests
  **physical isolation** (each live tenant has its own dedicated Neon project; flags missing or
  **shared** project ids — a cross-tenant violation) and **data residency** (region→jurisdiction,
  within the org allow-list; flags out-of-allow-list or unknown-jurisdiction regions), plus a
  status inventory. Deleted tenants are inventoried but excluded from attestations. Assembles
  existing assets (residency core, registry, audit event, allow-list); the CLI exits non-zero on any
  violation so a cron/CI can gate. It emits **evidence (queryable facts), not a legal certification**;
  erasure-history + full audit-trail excerpts are a follow-on (they need a persisted audit store).

- **Per-tenant quota enforcement** (gap #14) — meter each tenant's consumption (via the existing
  Neon usage provider) and evaluate it against per-tenant resource limits. The pure `evaluateQuota`
  (core, 100% covered) compares a `Quota` (`maxComputeTimeSeconds` / `maxActiveTimeSeconds` /
  `maxWrittenDataBytes` / `maxStorageBytes`; unset limits aren't enforced) against aggregated
  `Consumption` and returns the breaches. A new `QuotaEngine` + facade `checkQuota(id, period, quota)`
  / `checkQuotas(period, quota, { enforce })` (CLI `check-quotas --max-storage-gb /
--max-compute-seconds [--enforce]`) run the scheduled, failure-isolated sweep, emitting
  `tenant.quota_checked` / `tenant.quota_exceeded` audit events. **Enforcement is opt-in** —
  detection and alerting by default; `--enforce` **suspends** over-quota tenants (reversible, via the
  proper lifecycle transition), since auto-suspending a tenant is impactful, so it is never the
  default. Requires a usage provider; fails closed otherwise. Core + engine unit-tested.

- **Scheduled backups — off-Neon pg_dump archive tier** (gap #13, tier 2 of 2) — the durable,
  long-term complement to the in-Neon branch snapshots: `TenantForge.archive(id)` / `archiveFleet()`
  (CLI `archive`, `archive-fleet`) `pg_dump` each active tenant to an object store under the
  `archives/` key prefix, off-Neon so the artifact **survives project deletion** (unlike branches).
  Reuses the existing `pg_dump`-to-object-store exporter + `spawnPgDump` behind the `TenantExporter`
  port; wired in the production composition root when an export object store is configured
  (`TENANTFORGE_EXPORT_DIR`), and fails closed otherwise. Failure-isolated fleet sweep for a cron.
  **Archive retention is the object store's lifecycle policy** (e.g. S3/GCS lifecycle rules), not
  app-managed — documented in the backup-restore runbook. Engine paths unit-tested.

- **Scheduled backups — Neon branch snapshots** (gap #13, tier 1 of 2) — point-in-time tenant
  snapshots realized as **Neon branches** (copy-on-write — instant, cheap restore points), with
  scheduled fleet sweeps and retention pruning. New `SnapshotProvider` port + Neon-API adapter
  (create/list/delete/restore branches, schema-validated, bounded retries) and a `BackupEngine`
  (`TenantForge.snapshot` / `snapshotFleet` / `pruneSnapshots` / `restoreSnapshot`) wired into the
  production composition root; CLI `snapshot`, `snapshot-fleet`, `prune-snapshots`
  (`--max-count`/`--max-age-days`), and `restore-snapshot` (`--yes`-gated, destructive) for cron. The
  pure `planSnapshotPrune` (core, 100% covered) decides what to drop (keep newest `maxCount`, drop
  older than `maxAgeMs`); the engine sweep is failure-isolated. **Scope note:** snapshots are Neon
  branches inside the project — DR against bad migrations / corruption, **not** project deletion, and
  Neon's built-in PITR already covers the short window; an off-Neon **pg_dump → object-store archive
  tier** (for long-term / compliance durability) follows as a second PR. Core planner + engine
  unit-tested; the Neon adapter is integration/game-day-covered.

- **Fine-grained RBAC** (gap #12) — control-plane authorization moves from coarse admin/readonly to a
  required **permission per operation**, evaluated server-side and **deny by default** (std-owasp-api
  API5, topic-authn-authz). A pure core module (`src/core/authz.ts`, 100% covered) defines the
  permissions (`tenant:read|provision|suspend|offboard|purge`) and the role→permission map: `admin`
  holds all, the new **`operator`** runs the full reversible lifecycle but **cannot `tenant:purge`**
  (the irreversible op stays admin-only), `readonly` only reads. A principal may also carry an
  **explicit permission set** that narrows its role (e.g. scope an admin down). Wired through the
  token authenticator (`id:role:token`, role now `admin|operator|readonly`), the OIDC authenticator
  (validated role claim + optional `TENANTFORGE_OIDC_PERMISSIONS_CLAIM`), and per-route
  `requirePermission` middleware. Fully backward-compatible (existing admin/readonly tokens behave
  identically). Documented in `openapi.yaml`, README, and the threat model (E/EoP). Core + HTTP
  enforcement (operator-can't-purge, explicit-scope-down) unit-tested.

- **Idempotency-Key on HTTP mutations** (gap #11) — a client may set an `Idempotency-Key` header on
  any `POST /v1/*` so a retry **replays the original response** (header `Idempotency-Replayed: true`)
  instead of re-executing — most importantly for `provision`, whose once-only connection secret is
  replayed verbatim if the first response was lost (topic-api-design / topic-reliability). Keys are
  scoped per principal, fingerprinted by request (reuse with a different body → **422**; a still
  in-flight key → **409**; over-long key → 400), and expire after 24h. New `IdempotencyStore` port
  with an in-memory default and a cross-instance Postgres adapter (`tf_idempotency_keys`, migration 0005) selected via `TENANTFORGE_IDEMPOTENCY_STORE=pg` — so a retry landing on another replica still
  de-duplicates. Documented in `openapi.yaml`. In-memory store + middleware unit-tested; pg adapter
  integration-tested.

- **Operator audit attribution** (gap #10) — every control-plane event now records **who** performed
  the action (`TenantEvent.actor = { id, role }`), closing the who-did-what-when gap for
  non-repudiation (NIST AU, SOC2 change management, OWASP A09). A request-scoped actor context
  (`app/actor-context`, `AsyncLocalStorage` — like a correlation id) is set once at each entrypoint
  and read at the facade's single event-emit chokepoint, so no operation signature changes: the HTTP
  API attributes to the authenticated **principal** (`{ id, role }`), the CLI to the invoking OS user
  (`cli:<user>`), and the MCP agent surface to a fixed `mcp` operator. Actions with no request
  context (e.g. scheduled `rotateSecrets`/`purgeExpired` sweeps) are emitted unattributed rather than
  mislabelled. `actor.id` is an operator identity, never a secret. Context module + facade/HTTP/MCP
  attribution unit-tested.

- **Keyset pagination for the tenant list** (gap #9) — opaque `(created_at, id)` cursors let clients
  page a large fleet without `OFFSET` scans, consistently across all three control-plane surfaces.
  The pure `encodeCursor`/`decodeCursor` core (base64url `created_at|id`, opaque so clients treat it
  as a token) backs `TenantRegistry.list({ cursor })`, whose SQL filters `(created_at, id) < (cursor)`
  with a matching `ORDER BY created_at DESC, id DESC` (stable tiebreak). `GET /v1/tenants` decodes the
  cursor (**400 on malformed**) and returns `nextCursor` only when the page is full; the CLI `list`
  takes `--cursor` (prints `next-cursor:` when more remain) and the MCP `tf_list_tenants` takes an
  optional `cursor`, returns `nextCursor`, and rejects a malformed cursor **before** calling the
  service (fail closed). Backward-compatible: `cursor` is optional and `nextCursor` is additive. Core
  codec unit-tested at 100%; HTTP + MCP round-trip and bad-cursor paths covered.

- **Fleet migration drift detection + canary rollout** (gap #8). **Canary:**
  `migrateFleet(spec, { canaryTenantId })` applies to one tenant first and **aborts the fleet
  rollout if it fails** (report `canaryAborted`), so a bad migration is caught on one tenant, not all
  — the rest are untouched. **Drift:** `TenantForge.fleetStatus()` / `FleetOrchestrator.migrationStatus()`
  report which active tenants are behind the catalog's latest version or failing, backed by the new
  pure `computeFleetMigrationDrift` (core) and a new `TenantRegistry.listMigrations()`. Core + canary +
  status paths unit-tested at 100%.

- **Automated per-tenant secret rotation** (gap #7) — `TenantForge.rotateSecret(id)` /
  `rotateSecrets()` and `createSecretRotationEngine` automate the per-tenant connection-credential
  rotation that `docs/runbooks/secret-rotation.md` previously described manually. Rotating mints a new
  credential on the tenant's Neon project (new `ProvisioningProvider.rotateTenantCredential` — neon-api
  resets the owner role's password on the default branch, integration-verified via the game-day),
  stores it in the SecretStore, invalidates any cached connection, and emits a `tenant.secret_rotated`
  audit event; old/new URIs never logged. `rotateSecrets()` is the failure-isolated fleet sweep for a
  cron. Engine unit-tested at 100% (rotate ok / not-found / not-active; sweep with failure isolation +
  scan limit) + facade tests.

- **Programmatic restore + pg data mover** (gap #6) — `spawnPgRestore` restores a `pg_dump`
  custom-format archive into a target database (archive on **stdin**, password via `PGPASSWORD` off
  argv, fixed-arg `pg_restore`, timeout), the restore counterpart to the existing `spawnPgDump`
  backup. `createPgDataMover` pipes `pg_dump` → `pg_restore` to copy a tenant between databases — the
  concrete `TenantDataMover` for re-homing (#5), now **wired by default in the production composition
  root** so `rehome` works out of the box (requires `pg_dump`/`pg_restore` on PATH). Unit-tested at
  100% (safe args + PG\* env; no-`-d` when DB absent; non-zero exit / spawn error / no-stderr /
  timeout; mover dump-then-restore + default-spawn path).

- **Tenant re-homing** (gap #5) — `TenantForge.rehome(id, { region, residency? })` /
  `createRehomeEngine` relocates an **active** tenant to a new region (residency change / latency).
  A Neon project is region-bound, so it provisions a new project in the target region, **copies the
  data via an injected `TenantDataMover` port**, switches the registry (`relocate`) + connection
  secret over, then decommissions the old project. **Fail closed:** the target is validated first
  (`assertRehomeTarget` — allow-list + jurisdiction + must differ from current), a copy failure rolls
  back the freshly-created project and leaves the source intact, and the old project is deleted only
  after the switch (best-effort; a failure leaves a tracked orphan, not data loss). Emits a
  `tenant.rehomed` audit event; connection cache invalidated. The concrete pg data-mover ships with
  backup/restore (#6). Core validation + engine unit-tested at 100%.

- **Outbound lifecycle webhooks** (gap #4) — `createWebhookEventSink` delivers control-plane events
  to an operator-configured endpoint so external systems (billing/CRM/alerting) learn about
  provision / transition / erase as they happen (topic-webhooks, topic-notifications). Each POST is
  **HMAC-SHA256 signed** (`X-TenantForge-Signature` over `"{timestamp}.{body}"` + `X-TenantForge-Timestamp`
  for replay defence), **https-only** (construction fails closed otherwise), **never follows
  redirects** (SSRF defence), and **retries with exponential backoff + jitter** up to `maxAttempts`
  before dead-lettering via `onError`. Delivery is best-effort/non-blocking (fire-and-forget `emit`).
  Wired in the HTTP entrypoint via `TENANTFORGE_WEBHOOK_URL` + `TENANTFORGE_WEBHOOK_SECRET` (set
  together) with an optional `TENANTFORGE_WEBHOOK_EVENTS` allow-list; composes through the same
  fan-out as JSON + metrics. The signing secret is never logged. Unit-tested at 100%.

- **Prometheus metrics** (gap #3) — `createMetricsEventSink` derives **RED metrics** (rate / errors /
  duration) from the existing control-plane event stream (no scattered instrumentation): a
  `tenantforge_events_total{event,outcome}` counter and a `tenantforge_event_duration_ms` histogram,
  rendered in Prometheus text. `createFanOutEventSink` lets the JSON-to-stdout sink and the metrics
  sink coexist, and the HTTP entrypoint serves them at an unauthenticated `GET /metrics` (wired via a
  new `metrics` option on the server). Both adapters unit-tested at 100%.

- **Readiness probe** — a new `GET /ready` (distinct from the static liveness `GET /health`) backed by
  `TenantForge.health()`, which checks the **registry connectivity** (the hard dependency) and returns
  `200` healthy / `503` degraded so an orchestrator stops routing to an unhealthy instance
  (topic-reliability). `health()` is fail-soft (never throws); a new `TenantRegistry.ping()` (`SELECT 1`,
  touches no tenant data) backs it. The Neon API is a per-call upstream and is deliberately not probed
  on every readiness tick. Documented in `openapi.yaml`. Covered by HTTP + facade tests at 100%.

- **Connection-resolution cache** (`createCachingConnectionRouter`) — a process-local, tenant-keyed,
  TTL-bounded **LRU with single-flight** that wraps the connection router so a hot tenant's
  resolution (registry read + secret fetch) isn't repeated every request (topic-caching,
  topic-performance). Fails closed (a non-routable resolution is never cached) and is **invalidated
  on every lifecycle transition and on erasure**; TTL is the staleness backstop. Opt-in via
  `connectionCacheTtlMs` (`createTenantForge`) / `TENANTFORGE_CONNECTION_CACHE_TTL_MS` (0 = off).
  Caches _resolution_ only — live connection **pooling** remains the data-plane consumer's
  responsibility (the router hands out a URI). Unit-tested at 100%.

- **ErasureEngine** (ARCHITECTURE #17) — automated, audited right-to-erasure (GDPR Art. 17 / CCPA;
  workflow-data-lifecycle). `createErasureEngine` (adapter) orchestrates over the existing ports:
  optional final subject export → delete the Neon project → crypto-shred the connection secret → mark
  the record `deleted` → **verify** the post-conditions (secret unreadable + status deleted) → emit a
  redacted `tenant.erased` audit event (`outcome: 'error'` when a post-condition fails) → return an
  auditable `ErasureCertificate`. Unlike `purge`, erasure is the **legal-override** path — it applies
  from any state, not just an offboarded tenant. The pure `buildErasureCertificate` (core) encodes
  what counts as a _provably complete_ erasure. Exposed as `TenantForge.erase(id, { reason })` and as
  the standalone `createErasureEngine`. Pure core + orchestrator unit-tested at 100%.

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

[0.7.0]: https://github.com/0xb007ab1e/neon-tools/releases/tag/tenantforge-v0.7.0
[0.6.0]: https://github.com/0xb007ab1e/neon-tools/releases/tag/tenantforge-v0.6.0
[0.5.0]: https://github.com/0xb007ab1e/neon-tools/releases/tag/tenantforge-v0.5.0
[0.4.1]: https://github.com/0xb007ab1e/neon-tools/releases/tag/tenantforge-v0.4.1
[0.4.0]: https://github.com/0xb007ab1e/neon-tools/releases/tag/tenantforge-v0.4.0
[0.3.0]: https://github.com/0xb007ab1e/neon-tools/releases/tag/tenantforge-v0.3.0
[0.2.0]: https://github.com/0xb007ab1e/neon-tools/releases/tag/tenantforge-v0.2.0
[0.1.0]: https://github.com/0xb007ab1e/neon-tools/releases/tag/tenantforge-v0.1.0
