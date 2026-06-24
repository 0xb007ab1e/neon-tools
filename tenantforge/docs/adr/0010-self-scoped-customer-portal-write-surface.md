# ADR 0010 — Self-scoped customer-portal write surface (amends ADR-0004)

- **Status:** Accepted (2026-06-24) — Phase 1 backend implemented (`feat/portal-selfserve`); the destructive pair (cancel + erasure) is flag-gated OFF pending security review
- **Amends:** [ADR-0004](0004-secret-and-money-ops-off-the-agent-surface.md)

## Context

ADR-0004 gates money-/secret-/lifecycle-bearing operations **off** the MCP and dashboard surfaces,
keeping them on the authenticated CLI/HTTP plane. That ADR addressed the **operator** dashboard and
the **agent** (MCP) surface; the **customer self-serve portal** (`src/app/portal.ts`) was, and is,
**read-only** (threat-model B8). But a customer-facing SaaS needs self-serve account management —
update a card, change plan, see invoices, cancel, export/erase their data — without an operator in
the loop. The plan is `docs/research/portal-spa-plan.md`; the threat model is **B8w**.

The key question ADR-0004 raises: does letting a customer perform money/lifecycle actions reintroduce
the risks 0004 closed? The answer turns on **scope**. The portal already derives the tenant id
**only** from the signed session, never from request input (no route accepts a `tenantId`), and
tenant isolation is **physical** (one Neon project per tenant — ADR-0001). So a portal mutation is
structurally incapable of affecting another tenant. The relaxation is therefore narrow: a customer
acting on **its own account only**.

A design red-team (2026-06-24) upheld this core but required hardening on the two destructive paths;
its rulings are folded into the decision below.

## Decision

**Amend ADR-0004:** the customer portal becomes a **write surface for the authenticated tenant's own
account only** — distinct from the operator dashboard (still read-only per 0004) and the agent/MCP
surface (still excluded per 0004). Permitted self-serve actions: **update payment method, change
plan, view invoices/billing, cancel (offboard), data-export, and erasure** — each gated by blast
radius:

- **Tenant id is always session-derived, never client-supplied** (the BOLA invariant ADR-0004's
  spirit depends on). Money/lifecycle are permitted **but self-scoped**.
- **Money ops** (payment-method, plan change): CSRF (signed token in a custom header) + rate-limit +
  **endpoint-level idempotency** + server-side SetupIntent verification incl.
  `intent.customerRef === tenant.billingCustomerRef`. Card data via Stripe Elements (PAN off-server).
- **Cancel** = `offboard` (project retained, reversible) — **never** `purge`.
- **Erasure** (irreversible): typed confirmation **+ a control-plane-owned second factor**
  (single-use email/TOTP code — _not_ IdP `auth_time`) **+ a mandatory undo window** during which the
  tenant **keeps serving** and may cancel; execution is a single atomic conditional flip
  (no cancel/executor race), idempotent across redelivery; emits the signed erasure certificate and
  alerts operator + the tenant's verified email.
- **Rollout:** cancel + erasure ship behind a **feature flag, off** until their abuse tests are green
  and security-reviewed (deploy decoupled from release); the other actions go live first.

The agent/MCP and operator-dashboard gates of ADR-0004 are **unchanged** — this carve-out is the
customer portal only.

## Alternatives considered

- **Keep the portal read-only; operators fulfil all account changes** — rejected by the owner: not a
  viable self-serve SaaS; pushes routine work to operators.
- **Operator-request model** (customer requests, operator approves/executes cancel + erasure) —
  rejected (owner decision #1): customers get true self-serve, with strong gating instead of a human
  approver.
- **IdP `auth_time` recency for step-up** — rejected (red-team F1): an IdP can mint a fresh token via
  silent refresh/`prompt=none` with no human present; a control-plane second factor is used instead.
- **Suspend the tenant while erasure is pending** — rejected (red-team F2): creates a timer-delayed
  self-serve DoS; the tenant keeps serving until the executor runs.

## Consequences

- The portal can move money and run lifecycle actions, but **only for the calling tenant** — the
  cross-tenant/agent risks ADR-0004 closed remain closed (different surface, self-scoped, tested).
- New machinery: a one-time-code (second-factor) store, a pending-erasure state + atomic cancellable
  executor, endpoint-level idempotency wiring, portal CSRF, and self-serve-destructive alerting.
- Each new portal action must classify its blast radius and gating up front (as ADR-0004 requires for
  every feature). Cross-tenant **mutation** attempts join the abuse-test suite (threat-model B8w).
- Revisit if the portal ever needs to act beyond the calling tenant (it must not) or if a customer
  action gains operator-level blast radius (it must not).
