# ADR 0008 — Dep-light OpenTelemetry (the instrumented-library pattern)

- **Status:** Accepted (2026-06-22)

## Context

We want distributed tracing + correlation IDs across the four surfaces and into the Neon upstream.
The full OpenTelemetry **SDK + exporters + auto-instrumentations** is a large dependency tree —
significant supply-chain surface and bundle for a bootstrapped, solo-maintained OSS tool — and
baking an exporter into the library forces that choice on every consumer.

## Decision

Follow the **instrumented-library pattern**: depend only on **`@opentelemetry/api`** (tiny,
dependency-free, no-op by default). TenantForge **owns the correlation layer** (W3C `traceparent`
parse/format/validate in the pure core; an AsyncLocalStorage trace scope in the shell) so correlation
works with **zero configuration** — the trace id is the `correlationId` stamped on every event and
echoed as `x-correlation-id`, and propagated to the Neon API. Real **spans export only when the host
configures an OTel SDK** (e.g. `node --import @opentelemetry/auto-instrumentations-node/register`),
at which point we **adopt the active span's trace id** so our correlation aligns with the exported
trace. No SDK/exporter is bundled.

## Alternatives considered

- **Bundle `@opentelemetry/sdk-node` + OTLP exporter** — rejected: heavy deps + supply-chain surface
  always-on, and imposes the exporter choice on library consumers.
- **Home-grown correlation only (no OTel)** — rejected: we'd get correlation IDs but not _real_
  OpenTelemetry tracing when a host wants it.

## Consequences

- Minimal footprint: one small, stable dependency; spans are ~zero cost until an SDK is present.
- Correlation works out of the box (standalone) **and** integrates with a host's OTel stack.
- The host (not the library) owns exporter/endpoint config — the idiomatic split.
