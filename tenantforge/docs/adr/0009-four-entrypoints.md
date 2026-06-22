# ADR 0009 — One core, four entrypoints (library / CLI / HTTP / MCP)

- **Status:** Accepted (2026-06-22)

## Context

The control plane is consumed in different ways: embedded in an app, run by an operator at a
terminal, called over the network by other services, and driven by an LLM agent. Each could be a
separate codebase, but that would fork the logic and let the surfaces drift apart.

## Decision

Expose **one application core** (the `TenantForge` facade over the pure core + ports, ADR-0002)
through **four thin entrypoint adapters**:

- **Library** — `createTenantForge` / `tenantForgeFromConfig` for embedding.
- **CLI** — `citty` commands; the full surface (incl. `--yes`-gated money ops + secret-input ops).
- **HTTP** — a Hono control-plane API (per-operator auth, RBAC, rate limiting, OpenAPI contract).
- **MCP** — `@modelcontextprotocol/sdk` tools for agents, **gated** to the safe read/lifecycle subset
  (ADR-0004).

A web **dashboard** (read-only) is the human-facing window onto each feature. The OpenAPI document
is the HTTP contract and is **contract-tested** (served routes == documented routes; response shapes
validated).

## Alternatives considered

- **Separate apps per surface** — rejected: forks logic; surfaces drift; multiplies the security
  review surface.
- **HTTP-only, others call over the network** — rejected: the CLI/agent/library shouldn't require a
  running server; the core is usable in-process.

## Consequences

- Every surface shares the same validated core and authorization — fix once, fixed everywhere.
- A surface can legitimately expose a **subset** (MCP gating, read-only dashboard) — the gating is
  policy + permissions, asserted by tests.
- A new feature is wired across the surfaces that fit it (and a dashboard panel where it has output),
  not reimplemented per surface.
