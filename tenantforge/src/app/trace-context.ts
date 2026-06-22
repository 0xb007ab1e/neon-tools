import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { SpanKind, SpanStatusCode, trace as otelTrace } from '@opentelemetry/api';
import { TENANTFORGE } from '../meta.js';
import {
  formatTraceparent,
  isValidTraceId,
  parseTraceparent,
  type TraceParent,
} from '../core/trace.js';

/** The OpenTelemetry tracer for this tool. No-op until a host configures an SDK + exporter. */
const tracer = otelTrace.getTracer(TENANTFORGE.id, TENANTFORGE.version);

/** The trace scope of one in-flight operation (one request / command / tool call). */
export interface TraceContext {
  /** W3C trace id (32 hex) — the same value across every event + downstream call of this op. */
  traceId: string;
  /** This operation's span id (16 hex) — the parent span propagated to upstreams. */
  spanId: string;
  /** Correlation id surfaced to operators/clients. We use the trace id so logs ↔ traces line up. */
  correlationId: string;
}

/**
 * Operation-scoped trace context. The entrypoint (HTTP middleware / CLI command / MCP tool) starts
 * it once at the boundary; the facade's event emitter and the Neon client read it — so correlation
 * propagates without threading an id through every call. Separate from {@link runWithActor} because
 * a trace scopes *every* request (including unauthenticated/error paths), not just attributed ones.
 */
const storage = new AsyncLocalStorage<TraceContext>();

/** A random, non-zero 16-byte trace id as 32 lowercase hex chars. */
function randomTraceId(): string {
  return randomBytes(16).toString('hex');
}

/** A random, non-zero 8-byte span id as 16 lowercase hex chars. */
function randomSpanId(): string {
  return randomBytes(8).toString('hex');
}

/**
 * Derive a fresh {@link TraceContext} at an operation boundary. Trace-id precedence:
 *   1. an **active OpenTelemetry span** (a host that configured an OTel SDK already started the
 *      trace) — adopt its trace id so our correlation id == the exported trace;
 *   2. else a valid inbound W3C `traceparent` (continue the caller's distributed trace);
 *   3. else a newly generated trace id (standalone — tracing still correlates this operation).
 * The span id is always freshly generated for this hop (we are a new span within the trace).
 *
 * @param inboundTraceparent - The raw inbound `traceparent` header, if any (untrusted).
 * @returns The trace context to run the operation within.
 */
export function startTrace(inboundTraceparent?: string): TraceContext {
  const active = otelTrace.getActiveSpan()?.spanContext();
  const fromOtel = active !== undefined && isValidTraceId(active.traceId) ? active : undefined;
  const inbound: TraceParent | null = fromOtel ? null : parseTraceparent(inboundTraceparent);
  const traceId = fromOtel?.traceId ?? inbound?.traceId ?? randomTraceId();
  const spanId = randomSpanId();
  return { traceId, spanId, correlationId: traceId };
}

/**
 * Run `fn` with `context` as the ambient trace scope for the (async) call. Nested calls shadow the
 * outer context for their own scope.
 *
 * @param context - The trace context to install.
 * @param fn - The operation to run within the context.
 * @returns Whatever `fn` returns.
 */
export function runWithTrace<T>(context: TraceContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * The trace context in scope for the current async context, or `undefined` outside any
 * {@link runWithTrace} call.
 *
 * @returns The current {@link TraceContext}, or `undefined`.
 */
export function currentTrace(): TraceContext | undefined {
  return storage.getStore();
}

/**
 * The `traceparent` header value to propagate to an upstream (e.g. the Neon API), or `undefined`
 * when there's no trace scope. Propagates the current span as the upstream's parent (W3C).
 *
 * @returns A W3C `traceparent` value, or `undefined`.
 */
export function outboundTraceparent(): string | undefined {
  const ctx = storage.getStore();
  return ctx === undefined ? undefined : formatTraceparent(ctx.traceId, ctx.spanId);
}

/**
 * Run `fn` inside a new OpenTelemetry span **and** a matching {@link TraceContext}. The span is a
 * no-op (non-recording, ~zero cost) until a host configures an SDK + exporter, at which point it
 * exports and its real trace/span ids back the context (so logs ↔ traces align). On a thrown error
 * the span records the exception and is marked ERROR. Use at an operation boundary (e.g. an HTTP
 * request) to get a span; CLI/MCP that only need correlation can use {@link runWithTrace} directly.
 *
 * @param name - The span name (e.g. `GET /v1/tenants`).
 * @param fn - The operation to run within the span + trace scope.
 * @param opts - Optional inbound `traceparent` to continue, and span kind (default SERVER).
 * @returns Whatever `fn` returns.
 */
export function withOperationSpan<T>(
  name: string,
  fn: () => Promise<T>,
  opts: { inboundTraceparent?: string; kind?: SpanKind } = {},
): Promise<T> {
  return tracer.startActiveSpan(name, { kind: opts.kind ?? SpanKind.SERVER }, async (span) => {
    // Prefer the (recording) span's real ids when an SDK is active; otherwise continue an inbound
    // trace or generate one — so correlation works standalone and aligns with exports under an SDK.
    const sc = span.spanContext();
    const fromOtel = isValidTraceId(sc.traceId);
    const inbound: TraceParent | null = fromOtel ? null : parseTraceparent(opts.inboundTraceparent);
    const traceId = fromOtel ? sc.traceId : (inbound?.traceId ?? randomTraceId());
    const spanId = fromOtel ? sc.spanId : randomSpanId();
    const context: TraceContext = { traceId, spanId, correlationId: traceId };
    span.setAttribute('tenantforge.correlation_id', context.correlationId);
    try {
      return await runWithTrace(context, fn);
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
