# ADR 0006 — The control-plane DB holds metadata only; secrets live in a SecretStore

- **Status:** Accepted (2026-06-22)

## Context

The control plane has its own registry database (tenant records, fleet-migration state, idempotency
keys, audit trail, credits, signup tokens, webhook subscriptions). It also handles **secrets**:
per-tenant connection URIs and per-subscription webhook signing secrets. Master §5 requires secrets
encrypted at rest under a key separate from the credential that accesses the service, and never
stored in plaintext alongside metadata.

## Decision

- The **control-plane registry stores metadata only** — never tenant _content_, and never a secret
  value. (No real tenant data in non-prod, either.)
- **Secrets live behind a dedicated `SecretStore` port**, keyed by an id (`<tenantId>` for
  connection URIs, `webhook-sub:<id>` for signing secrets). The default adapter is **AES-256-GCM
  encrypted in the control-plane Postgres** with a key (`TENANTFORGE_SECRET_KEY`) **separate from the
  DB credential** (separation of duties); Vault / AWS / GCP secret-manager adapters satisfy the same
  port.
- Secrets are returned **once** at creation, never re-read to a client, **crypto-shredded** on
  offboard/delete, and **redacted** from every event/log/trace (a fixed key allow-list scrubs them
  at the observability boundary).

## Alternatives considered

- **Store secrets in registry columns** — rejected: violates separate-key-at-rest; a registry dump
  would leak live credentials.
- **Hash the secret (like signup tokens)** — works for _verifying_ a presented token, but a webhook
  signing secret must be **retained** to sign outbound HMACs, so it's stored recoverable in the
  encrypted SecretStore, not hashed.

## Consequences

- A registry backup/dump contains no usable secret.
- Offboarding crypto-shreds a tenant's secret (right-to-erasure; `@rules/workflow-data-lifecycle.md`).
- The dispatch path reads secrets from the SecretStore at use time (a cost noted for the webhook
  fan-out; cacheable later).
