# ADR 0002 — Ports & adapters with a pure functional core

- **Status:** Accepted (2026-06-22)

## Context

The control plane mixes pure decision logic (slug/region validation, the lifecycle state machine,
fleet-migration planning, billing/proration, anomaly/digest classification) with heavy I/O (the Neon
API, Postgres, secret stores, object stores, payment gateways, notifiers). Coupling the two makes
the logic hard to test and the infrastructure hard to swap.

## Decision

Adopt **hexagonal (ports & adapters)** with a **functional core, imperative shell**:

- `src/core/**` is **pure** — no I/O, deterministic. It holds the domain rules and is unit-tested
  **without mocks** and to **100% coverage** (a CI gate).
- I/O is expressed as **ports** (`src/ports/**`) the core/facade depend on; concrete **adapters**
  (`src/adapters/**`) implement them (Neon API, `pg`, Vault/AWS/GCP secret stores, S3/GCS/fs object
  stores, Stripe gateway, SES/SMTP/http notifiers, …). Dependencies are injected at the composition
  root (`tenantForgeFromConfig`).

## Alternatives considered

- **Service classes calling SDKs directly** — rejected: logic becomes untestable without live
  infra; swapping a backend means editing business code.
- **Framework-coupled (controllers own logic)** — rejected: ties the domain to HTTP/Hono.

## Consequences

- The valuable, correctness-critical logic is trivially testable and held at 100% — pairs with
  mutation testing on the money/authz core.
- Backends are swappable behind a port without touching the core (e.g. secret store: encrypted-pg
  vs Vault; exporter: neon-archive vs pg-dump).
- The four entrypoints (ADR-0009) are thin adapters over the same core.
- Some ceremony (ports + adapters + wiring) — accepted as proportionate for a long-lived,
  infrastructure-rich service; small scripts wouldn't warrant it.
