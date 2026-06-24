# Architecture Decision Records (ADRs)

This log captures the **significant, hard-to-reverse decisions** behind TenantForge and the _why_
behind each — context, the decision, alternatives weighed, and consequences. ADRs are **immutable**:
when a decision changes we add a new record that supersedes the old one (we don't rewrite history).
They complement [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) (the holistic design) by recording
individual choices in isolation.

Format: a trimmed [Nygard ADR](https://adr.github.io/) — Status · Context · Decision · Alternatives ·
Consequences. New ADRs take the next number; set Status to `Proposed`, then `Accepted` on merge (or
`Superseded by ADR-NNNN`).

| #                                                                 | Decision                                                                | Status   |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------- | -------- |
| [0001](0001-database-per-tenant-physical-isolation.md)            | Database-per-tenant (physical isolation), not shared-schema             | Accepted |
| [0002](0002-ports-and-adapters-functional-core.md)                | Ports & adapters with a pure functional core                            | Accepted |
| [0003](0003-tenant-context-derived-server-side.md)                | Tenant context is derived server-side, never from the client            | Accepted |
| [0004](0004-secret-and-money-ops-off-the-agent-surface.md)        | Secret-/money-bearing ops are gated off the MCP + dashboard surfaces    | Accepted |
| [0005](0005-fleet-migrations-expand-contract-failure-isolated.md) | Fleet migrations: expand/contract, failure-isolated, resumable          | Accepted |
| [0006](0006-control-plane-db-metadata-only.md)                    | The control-plane DB holds metadata only; secrets live in a SecretStore | Accepted |
| [0007](0007-neon-api-as-untrusted-upstream.md)                    | The Neon API is treated as an untrusted upstream                        | Accepted |
| [0008](0008-dep-light-opentelemetry.md)                           | Dep-light OpenTelemetry (the instrumented-library pattern)              | Accepted |
| [0009](0009-four-entrypoints.md)                                  | One core, four entrypoints (library / CLI / HTTP / MCP)                 | Accepted |
| [0010](0010-self-scoped-customer-portal-write-surface.md)         | Self-scoped customer-portal write surface (amends 0004)                 | Proposed |
