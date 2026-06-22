import {
  type Context,
  type ContextManager,
  ROOT_CONTEXT,
  type SpanContext,
  TraceFlags,
  context,
  trace,
} from '@opentelemetry/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isValidSpanId, isValidTraceId, parseTraceparent } from '../../src/core/trace.js';
import {
  currentTrace,
  outboundTraceparent,
  runWithTrace,
  startTrace,
  withOperationSpan,
} from '../../src/app/trace-context.js';

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPAN_ID = 'b7ad6b7169203331';

/**
 * A minimal synchronous context manager. `@opentelemetry/api`'s default manager is a no-op (it
 * needs an SDK to propagate context), so we register this to simulate a host having configured an
 * OTel SDK — letting us exercise the active-span adoption path.
 */
class StackContextManager implements ContextManager {
  private _active: Context = ROOT_CONTEXT;
  active(): Context {
    return this._active;
  }
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    const previous = this._active;
    this._active = ctx;
    try {
      return fn.call(thisArg as ThisParameterType<F>, ...args);
    } finally {
      this._active = previous;
    }
  }
  bind<T>(_ctx: Context, target: T): T {
    return target;
  }
  enable(): this {
    return this;
  }
  disable(): this {
    this._active = ROOT_CONTEXT;
    return this;
  }
}

beforeAll(() => {
  context.setGlobalContextManager(new StackContextManager());
});
afterAll(() => {
  context.disable();
});

/** Run `fn` with a valid OTel span active (simulating a host SDK having started the trace). */
function withActiveSpan<T>(traceId: string, spanId: string, fn: () => T): T {
  const spanContext: SpanContext = {
    traceId,
    spanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  };
  const span = trace.wrapSpanContext(spanContext);
  return context.with(trace.setSpan(context.active(), span), fn);
}

describe('startTrace', () => {
  it('generates a fresh, valid trace + span id when there is no inbound or active context', () => {
    const ctx = startTrace();
    expect(isValidTraceId(ctx.traceId)).toBe(true);
    expect(isValidSpanId(ctx.spanId)).toBe(true);
    expect(ctx.correlationId).toBe(ctx.traceId); // correlation id IS the trace id
  });

  it('continues a valid inbound traceparent (adopts trace id, fresh span id)', () => {
    const ctx = startTrace(`00-${TRACE_ID}-${SPAN_ID}-01`);
    expect(ctx.traceId).toBe(TRACE_ID);
    expect(ctx.spanId).not.toBe(SPAN_ID); // we are a new span within the inbound trace
    expect(isValidSpanId(ctx.spanId)).toBe(true);
  });

  it('ignores a malformed inbound traceparent and generates a new trace', () => {
    const ctx = startTrace('not-a-traceparent');
    expect(ctx.traceId).not.toBe(TRACE_ID);
    expect(isValidTraceId(ctx.traceId)).toBe(true);
  });

  it('adopts the active OpenTelemetry span’s trace id (host SDK integration)', () => {
    const ctx = withActiveSpan(TRACE_ID, SPAN_ID, () => startTrace());
    expect(ctx.traceId).toBe(TRACE_ID);
    expect(ctx.correlationId).toBe(TRACE_ID);
  });
});

describe('runWithTrace / currentTrace', () => {
  it('exposes the context inside the scope and nothing outside it', () => {
    expect(currentTrace()).toBeUndefined();
    const ctx = startTrace();
    const seen = runWithTrace(ctx, () => currentTrace());
    expect(seen).toBe(ctx);
    expect(currentTrace()).toBeUndefined();
  });
});

describe('outboundTraceparent', () => {
  it('is undefined outside any trace scope', () => {
    expect(outboundTraceparent()).toBeUndefined();
  });

  it('formats the current context and round-trips back to its ids', () => {
    const ctx = startTrace();
    const header = runWithTrace(ctx, () => outboundTraceparent());
    expect(header).toBeDefined();
    expect(parseTraceparent(header)).toEqual({ traceId: ctx.traceId, spanId: ctx.spanId });
  });
});

describe('withOperationSpan', () => {
  it('runs fn inside a trace scope and returns its result; scope clears after', async () => {
    expect(currentTrace()).toBeUndefined();
    const result = await withOperationSpan('test.op', async () => {
      const ctx = currentTrace();
      expect(ctx).toBeDefined();
      expect(ctx?.correlationId).toBe(ctx?.traceId);
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(currentTrace()).toBeUndefined();
  });

  it('continues an inbound traceparent', async () => {
    const seen = await withOperationSpan('test.op', async () => currentTrace()?.traceId, {
      inboundTraceparent: `00-${TRACE_ID}-${SPAN_ID}-01`,
    });
    expect(seen).toBe(TRACE_ID);
  });

  it('rethrows fn errors (span marked error) and clears the scope', async () => {
    await expect(
      withOperationSpan('test.op', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(currentTrace()).toBeUndefined();
  });
});
