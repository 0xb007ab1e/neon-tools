# ADR 0004 — Secret-/money-bearing ops are gated off the MCP + dashboard surfaces

- **Status:** Accepted (2026-06-22)

## Context

TenantForge exposes the same core through four surfaces (ADR-0009), including an **MCP server** an
LLM agent drives and a **web dashboard**. Some operations move money (charge/refund/credit, plan
settlement), accept or return a **secret** (provision returns a connection URI; import accepts one;
webhook-subscription create returns a signing secret), or are irreversible (purge). Exposing those
to an autonomous agent is excessive agency (`@rules/std-owasp-llm.md` LLM08), and routing secrets
through an agent's context or a browser is a disclosure risk.

## Decision

Gate operations by surface, by their blast radius:

- **MCP (agent) surface:** read/report tools + **reversible, non-secret, non-money** lifecycle
  (suspend/resume/offboard/restore). **Excluded:** charge/refund/credit, plan change/assign,
  signup issue/redeem, export, webhook create/delete, **purge** — anything money-moving,
  secret-bearing, or irreversible. The MCP server runs as a single attributed `mcp` operator.
- **Dashboard:** **read-only** panels (+ the one `tenant:provision`-gated reconcile action);
  no money/secret/lifecycle mutations.
- **CLI + HTTP:** the full surface, including secret-/money-bearing ops — authenticated, and money
  ops additionally `--yes`-gated on the CLI. Secrets are returned **once** to the authenticated
  caller (HTTP body / CLI stdout from env input), never logged.

## Alternatives considered

- **Expose everything everywhere (uniform surface)** — rejected: hands an agent irreversible/
  money/secret power; puts secrets in agent context and the browser.
- **Per-tool human-approval prompts on MCP** — heavier than excluding them; the gate policy
  (`@rules/workflow-gated-actions.md`) prefers least capability on the agent surface.

## Consequences

- The agent surface is **safe by construction** — it cannot move money, leak a secret, or do
  anything irreversible. Tests assert these tools are absent from the MCP surface.
- Automation that legitimately needs those ops uses the CLI/HTTP (authenticated, audited).
- Each new feature must classify its surface up front (e.g. operator-digest is read-only → all
  surfaces; webhook create returns a secret → CLI/HTTP only).
