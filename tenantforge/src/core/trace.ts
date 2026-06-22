/**
 * Pure W3C Trace Context (`traceparent`) helpers — the format/validation half of distributed
 * tracing, kept I/O-free so it's exhaustively unit-testable (id *generation* + the AsyncLocalStorage
 * live in the imperative shell). An inbound `traceparent` is **untrusted input**, so parsing
 * validates strictly and fails closed to `null` (std-owasp-proactive #5).
 *
 * @see https://www.w3.org/TR/trace-context/ — `version-traceId-spanId-flags` (`00-…-…-01`).
 */

/** The W3C trace-context header name. */
export const TRACEPARENT_HEADER = 'traceparent';

/** A parsed trace context: a 32-hex-char trace id and a 16-hex-char (parent) span id. */
export interface TraceParent {
  /** 16-byte trace id as 32 lowercase hex chars (never all-zero). */
  traceId: string;
  /** 8-byte span id as 16 lowercase hex chars (never all-zero). */
  spanId: string;
}

/** All-zero ids are invalid per the spec (they denote "no trace"). */
const ALL_ZERO_TRACE = '0'.repeat(32);
const ALL_ZERO_SPAN = '0'.repeat(16);

/** Whether `value` is a valid, non-zero 32-hex-char trace id. */
export function isValidTraceId(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value) && value !== ALL_ZERO_TRACE;
}

/** Whether `value` is a valid, non-zero 16-hex-char span id. */
export function isValidSpanId(value: string): boolean {
  return /^[0-9a-f]{16}$/.test(value) && value !== ALL_ZERO_SPAN;
}

/**
 * Parse a W3C `traceparent` header, returning its trace + span ids, or `null` if absent/malformed.
 *
 * Accepts the version-`00` format `00-<32hex>-<16hex>-<2hex>`; rejects anything else (wrong field
 * count, bad hex, all-zero ids) so a bad upstream header can't poison correlation.
 *
 * @param header - The raw header value (may be `undefined`).
 * @returns The parsed ids, or `null` when the header is missing or invalid.
 */
export function parseTraceparent(header: string | undefined): TraceParent | null {
  if (header === undefined) return null;
  const parts = header.trim().split('-');
  if (parts.length !== 4) return null;
  const [version, traceId, spanId, flags] = parts as [string, string, string, string];
  // Only version 00 is defined; reject the "forbidden" version ff and any non-2-hex version.
  if (!/^[0-9a-f]{2}$/.test(version) || version === 'ff') return null;
  if (!/^[0-9a-f]{2}$/.test(flags)) return null;
  if (!isValidTraceId(traceId) || !isValidSpanId(spanId)) return null;
  return { traceId, spanId };
}

/**
 * Format a `traceparent` header value (version 00, sampled flag set) for outbound propagation.
 *
 * @param traceId - A valid 32-hex-char trace id.
 * @param spanId - A valid 16-hex-char span id (the current span, which becomes the upstream parent).
 * @returns The header value, e.g. `00-<traceId>-<spanId>-01`.
 * @throws If either id is invalid (fail closed — never emit a malformed header).
 */
export function formatTraceparent(traceId: string, spanId: string): string {
  if (!isValidTraceId(traceId)) throw new Error('invalid trace id');
  if (!isValidSpanId(spanId)) throw new Error('invalid span id');
  return `00-${traceId}-${spanId}-01`;
}
