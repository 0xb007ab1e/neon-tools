# ADR 0007 — The Neon API is treated as an untrusted upstream

- **Status:** Accepted (2026-06-22)

## Context

Provisioning, re-homing, and credential rotation depend on the **Neon API** — a network call to a
third party that can be slow, fail, rate-limit, or return unexpected shapes. Treating it as always-
available and well-formed would make the control plane brittle and a target for injection via
reflected upstream data (`@rules/topic-api-consumption.md`, `@rules/std-owasp-api.md` API10).

## Decision

Every Neon API call goes through an adapter that treats the upstream as **unreliable and untrusted**:

- **Timeouts** on every request (no unbounded waits); **bounded retries** with exponential backoff
  for transient failures only.
- **Schema-validate responses** before use (parse, don't trust); fail closed on a bad shape.
- **TLS enforced** (https), with a documented local-only insecure opt-out.
- **Least-privilege credentials** from the secret manager / env — one API key, never per-tenant
  "god" creds; the key is never logged.
- The org-scoped account requires `NEON_ORG_ID`; provisioning is **idempotent + resumable** so a
  mid-call failure can be retried safely.

## Alternatives considered

- **Trust the SDK/HTTP defaults** — rejected: no timeout/retry/validation discipline; one slow or
  malformed upstream response degrades or corrupts the control plane.

## Consequences

- The control plane degrades gracefully under Neon API trouble rather than hanging or crashing.
- Reflected upstream data can't drive injection; unexpected shapes are rejected, not propagated.
- Adapters are integration-tested against an ephemeral Neon branch in CI (the live game-day),
  since the value is in the real interaction.
