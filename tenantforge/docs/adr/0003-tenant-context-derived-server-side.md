# ADR 0003 — Tenant context is derived server-side, never from the client

- **Status:** Accepted (2026-06-22)

## Context

The #1 API risk for a multi-tenant control plane is **Broken Object Level Authorization** (BOLA /
IDOR — `@rules/std-owasp-api.md` API1): trusting a client-supplied tenant identifier and serving
another tenant's data or operating on their project.

## Decision

The tenant a request may act on is **derived server-side from the authenticated principal**, never
taken from a client-supplied tenant id. Authentication resolves a request to a principal `{ id,
role }` behind the `Authenticator` port (token or OIDC JWT); authorization is enforced **server-side
on every route** with a required permission per operation, deny-by-default (`can()` in the pure
authz core). Object ownership / tenant scope is checked on every access. Cross-tenant access is an
explicit **negative test** in the suite, not an assumption.

## Alternatives considered

- **Trust a `tenantId` request field/param** — rejected: textbook BOLA.
- **Client-side authorization (hide UI)** — rejected: never a control; the client is untrusted.

## Consequences

- A path's tenant id identifies the object; the **bearer token is the authority** — a deployment
  derives scope from the principal, never widening it from client input.
- RBAC is identical across token and OIDC modes; roles expand to permission sets, narrowable per
  token (scope an admin _down_), evaluated in the pure core (testable, mutation-covered).
- Residency/jurisdiction is enforced server-side at provision/import (fail closed on mismatch).
- Secret-/money-bearing operations are further restricted by surface (ADR-0004).
