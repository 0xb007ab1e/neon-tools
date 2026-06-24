# Architecture — `neon`

A pnpm-workspace monorepo of two **independent** products that share one architectural
style — **ports & adapters with a functional core / imperative shell**. They do not call each
other at runtime; they coexist in the workspace and reuse the same patterns.

| Product | What it is |
|---|---|
| **[TenantForge](tenantforge/)** | Multi-tenant SaaS control plane that provisions a **physical Neon project per tenant** (not shared-schema). Self-serve signup, tenant lifecycle, fleet-wide migrations, usage billing. The control-plane DB holds **metadata only** — never tenant content. |
| **[VectorNest](vectornest/)** | Multi-tenant vector-search / RAG service over Neon Postgres + pgvector. Hybrid vector + full-text retrieval; versioned embedding models with eval-gated activation. |

Per-product detail lives in [`tenantforge/ARCHITECTURE.md`](tenantforge/ARCHITECTURE.md) and
[`vectornest/ARCHITECTURE.md`](vectornest/ARCHITECTURE.md); TenantForge's design decisions are
recorded as numbered ADRs in [`tenantforge/docs/adr/`](tenantforge/docs/adr/). This document is
the cross-product map.

## Stack

- **Node LTS, TypeScript strict, ESM.** HTTP via **Hono**, CLI via **citty**, agent surface via
  the **MCP SDK**, validation via **zod**, Postgres via `pg`.
- **Persistence:** Neon Postgres — TenantForge's registry stores tenant *metadata*; VectorNest
  uses **pgvector** + Postgres **full-text search**.
- **Untrusted upstreams** (all wrapped with timeouts, bounded retries, TLS assertion, and
  schema validation): the **Neon API** (provisioning/branching), **Stripe** (payments), and an
  **OpenAI-compatible** embedding API.
- Predominantly interface/function-driven (≈1,300 functions, ≈400 interfaces, a handful of
  classes).

## Layering

Each product layers the same way, with dependencies pointing inward:

```
app/        imperative shell + entrypoints (HTTP, MCP, CLI, worker)
  │
adapters/   port implementations (Neon PG, Neon API, Stripe, KMS backends, queues, object stores)
  │
ports/      interfaces the core depends on
  │
core/       pure domain logic — decisions & math, zero I/O, unit-testable without mocks
```

Collaborators are constructed at a **composition root** (`tenantForgeFromConfig` /
`vectorNestFromConfig`) and injected; the core never imports a transport, DB, or vendor.

### Entrypoints

- **TenantForge (four):** `http-server` (REST `/v1/*`, and mounts the dashboard, customer
  portal, and signup sub-apps), `mcp-server` (agent surface — **money & secret operations are
  deliberately excluded**), `cli`, and `worker` (drains the Postgres lifecycle queue).
- **VectorNest (three):** `http-server`, `mcp-server`, `cli` (no worker — no async lifecycle queue).

## Major flows

### TenantForge

**Signup** (`app/signup.ts`, a Hono sub-app mounted at `/signup`) — a rate-limited funnel,
each step gated by a per-IP fixed-window limiter and an HMAC session cookie:

```
/api/config  → public keys only (Stripe publishable + captcha site key)
/api/start   → captcha + email; mints email code + session cookie
/api/verify-email → checks the emailed code
/api/payment-intent → opens a Stripe SetupIntent
/api/complete → verifies the saved payment method SERVER-SIDE, enqueues provisioning
/api/status  → polled; one-time connection-URI reveal once the tenant is active
```

A scoped CSP on the signup sub-app allows Stripe.js + Cloudflare Turnstile without loosening
the strict dashboard CSP.

**Provisioning (async)** — `completeSignup` enqueues a `provision` command:

```
completeSignup ──enqueue──▶ Postgres lifecycle queue
                                   │
worker poll loop → lifecycle-consumer.drain (at-least-once: dedupe · ack · dead-letter)
                                   │
                            lifecycle-handler → provision → finishProvisioning
                                   │
            Neon API create project → registry.attachProject → secretStore.set → status=active
```

**Lifecycle (two-phase, reversible → irreversible):**

- `offboard` — transition to `offboarding` + export an archive; the Neon project is **retained**
  (Neon scales it to ≈ $0), so it is reversible until purge.
- `purge` / `purgeExpired` sweep — irreversible delete **after** the retention window; an
  `assertTransition` guard enforces offboard-first.
- `erase` (GDPR right-to-be-forgotten) — optional final export, delete, then a **verified
  ErasureCertificate**; overrides the offboard-first rule.

**Fleet migration** — pure planners (`planFleetMigration`, `planFleetReconcile`,
`computeFleetMigrationDrift`) + a `fleet-orchestrator`. **Canary-first**, sequential batches with
concurrency *within* a batch, **per-tenant failure isolation**, a **checksum drift guard**
(editing an applied migration throws — bump the version), and resumability via persisted
per-tenant migration state.

**Billing** — pure core (`buildInvoice`, `chargeIdempotencyKey`, `creditToApply`,
`dunningStateFromCharges`) under a `billingRun` that charges the fleet (idempotently) then runs a
dunning sweep (a `wait → retry → suspend` state machine). Money is handled as **integer minor
units + currency** (never floats); idempotency keys are **period-stable**; credit is applied
before the card; inbound payment webhooks verify an **HMAC over the raw body**.

### VectorNest

- **Ingest** — stream documents → **content-hash dedup** → chunk → **batched** embedding →
  upsert → build the HNSW index.
- **Query** — three modes: `keyword` (FTS), `vector` (pgvector cosine), and `hybrid`
  (**Reciprocal Rank Fusion** of both, deeper fan-out then fuse to top-k). `k` is bounded 1..100.
- **Re-embedding** — version a *new* embedding model, **rehearse on a Neon branch**, pass an
  **eval gate** (`meetsThresholds`), then `activateModel` (zero-downtime swap; the prior model
  stays registered for rollback).

## Shared substrate

Every flow above rests on three cross-cutting subsystems:

- **Connection routing** — `connection-router.resolve` (`registry.getById` → `assertRoutable` →
  `secretStore.get`) wrapped by a **caching** router (TTL + single-flight coalescing +
  invalidate-on-status-change), so a suspended/offboarded tenant immediately stops routing.
- **Secret store + crypto** — a `SecretStore` port with in-memory, Neon-PG-sealed, Vault, AWS,
  GCP, and Azure backends. `secret-crypto` is **AES-256-GCM** with a per-call random 12-byte
  nonce and a scrypt-derived key; it **fails closed** on tamper. Crypto-shredding = deleting the
  secret.
- **Audit / observability** — `observe` → `eventSink.emit` → audit-log store, with **mandatory
  recursive secret redaction** at the boundary and actor/trace context via AsyncLocalStorage. The
  same trail feeds anomaly detection, compliance export, dunning, and refund proration.

## Cross-cutting patterns

- **Functional core / imperative shell** — pure decisions and math; I/O pushed to injected adapters.
- **Idempotency wherever mutation meets retries** — lifecycle queue (at-least-once + dedupe +
  DLQ), period-stable charge keys, ingest content-hash, period-keyed credit consumption.
- **Failure isolation for fleet operations** — one tenant's failure never aborts the sweep
  (migration, reconcile, dunning, purge, rotation).
- **Explicit state machines** with `assertTransition` guards (tenant lifecycle, dunning, reconcile ordering).
- **Canary-first + eval/quality gates** before any fleet rollout or model activation.
- **Anti-corruption against untrusted upstreams** — timeouts, bounded retries, schema validation,
  no redirect-to-internal.

## Key trade-offs

- **Physical isolation (project-per-tenant)** over shared-schema: strongest isolation plus
  per-tenant residency and erasure, at higher provisioning cost — mitigated by Neon scale-to-zero
  (offboarded projects ≈ $0, enabling a reversible grace period before purge).
- **Async provisioning via a poll-loop worker**: resilient and retryable, but signup completes in
  a "pending" state and the SPA polls for activation.
- **Lifecycle-consumer dedupe is in-memory per process**; true cross-restart idempotency relies on
  `provision`/`finishProvisioning` being idempotent, not on the dedupe set.
- **A single workspace secret key** (scrypt + domain-separation salt) rather than per-tenant keys:
  simpler, with crypto-shredding done per-record via secret deletion rather than per-key.

## Quality & testing

`test/` mirrors `src/` nearly file-for-file across `core/`, `adapters/`, and `app/`, plus
**contract** tests (OpenAPI + MCP tools) and **integration** suites that run against ephemeral
Neon branches. Mutation testing is configured (`tenantforge/stryker.config.mjs`). Every new
TenantForge feature also ships a **WCAG 2.2 AA** dashboard panel as its human-facing window
(tailnet-only in dev).
