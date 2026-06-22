import { describe, expect, it } from 'vitest';
import {
  TRACEPARENT_HEADER,
  formatTraceparent,
  isValidSpanId,
  isValidTraceId,
  parseTraceparent,
} from '../../src/core/trace.js';

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPAN_ID = 'b7ad6b7169203331';
const VALID = `00-${TRACE_ID}-${SPAN_ID}-01`;

describe('isValidTraceId', () => {
  it('accepts a non-zero 32-hex id', () => {
    expect(isValidTraceId(TRACE_ID)).toBe(true);
  });
  it('rejects all-zero, wrong length, and non-hex', () => {
    expect(isValidTraceId('0'.repeat(32))).toBe(false);
    expect(isValidTraceId('abc')).toBe(false);
    expect(isValidTraceId('g'.repeat(32))).toBe(false);
    expect(isValidTraceId(TRACE_ID.toUpperCase())).toBe(false); // must be lowercase hex
  });
});

describe('isValidSpanId', () => {
  it('accepts a non-zero 16-hex id', () => {
    expect(isValidSpanId(SPAN_ID)).toBe(true);
  });
  it('rejects all-zero, wrong length, and non-hex', () => {
    expect(isValidSpanId('0'.repeat(16))).toBe(false);
    expect(isValidSpanId('abc')).toBe(false);
    expect(isValidSpanId('z'.repeat(16))).toBe(false);
  });
});

describe('parseTraceparent', () => {
  it('parses a valid version-00 header', () => {
    expect(parseTraceparent(VALID)).toEqual({ traceId: TRACE_ID, spanId: SPAN_ID });
  });
  it('trims surrounding whitespace', () => {
    expect(parseTraceparent(`  ${VALID}  `)).toEqual({ traceId: TRACE_ID, spanId: SPAN_ID });
  });
  it('returns null for a missing header', () => {
    expect(parseTraceparent(undefined)).toBeNull();
  });
  it('returns null for the wrong field count', () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}`)).toBeNull();
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-01-extra`)).toBeNull();
  });
  it('returns null for a non-hex or forbidden version', () => {
    expect(parseTraceparent(`zz-${TRACE_ID}-${SPAN_ID}-01`)).toBeNull();
    expect(parseTraceparent(`ff-${TRACE_ID}-${SPAN_ID}-01`)).toBeNull();
  });
  it('returns null for malformed flags', () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-0`)).toBeNull();
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-zz`)).toBeNull();
  });
  it('returns null for an invalid trace id or span id', () => {
    expect(parseTraceparent(`00-${'0'.repeat(32)}-${SPAN_ID}-01`)).toBeNull();
    expect(parseTraceparent(`00-${TRACE_ID}-${'0'.repeat(16)}-01`)).toBeNull();
    expect(parseTraceparent(`00-tooshort-${SPAN_ID}-01`)).toBeNull();
  });
});

describe('formatTraceparent', () => {
  it('formats a sampled version-00 header', () => {
    expect(formatTraceparent(TRACE_ID, SPAN_ID)).toBe(VALID);
  });
  it('round-trips with parseTraceparent', () => {
    expect(parseTraceparent(formatTraceparent(TRACE_ID, SPAN_ID))).toEqual({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
    });
  });
  it('throws (fail closed) on an invalid trace id', () => {
    expect(() => formatTraceparent('0'.repeat(32), SPAN_ID)).toThrow(/invalid trace id/);
  });
  it('throws (fail closed) on an invalid span id', () => {
    expect(() => formatTraceparent(TRACE_ID, 'nope')).toThrow(/invalid span id/);
  });
});

describe('TRACEPARENT_HEADER', () => {
  it('is the W3C header name', () => {
    expect(TRACEPARENT_HEADER).toBe('traceparent');
  });
});
