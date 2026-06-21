/**
 * A raw audit-trail query as it arrives from a boundary (CLI flags / HTTP query params) — all
 * fields optional and untrusted. Normalized by {@link normalizeAuditQuery} before it reaches the
 * store. Kept in the pure core (no port import) so the dependency direction stays inward.
 */
export interface AuditQueryInput {
  /** Restrict to these event names; empty/blank entries are dropped. */
  events?: string[];
  /** Restrict to one tenant. */
  tenantId?: string;
  /** Only events at/after this instant (ISO-8601 UTC). */
  since?: string;
  /** Max rows (newest-first); clamped to a sane bound. */
  limit?: number;
}

/** A validated, bounded audit query: `limit` is always present, blanks dropped. */
export interface NormalizedAuditQuery {
  events?: string[];
  tenantId?: string;
  since?: string;
  limit: number;
}

/** Bounds for {@link normalizeAuditQuery}. */
export interface AuditQueryBounds {
  /** Default row cap when none is supplied. */
  defaultLimit?: number;
  /** Hard upper bound on rows (a query is always bounded — master §4 / DoS). */
  maxLimit?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/**
 * Validate + normalize an untrusted {@link AuditQueryInput} into a bounded {@link NormalizedAuditQuery}.
 * Pure and deterministic. De-duplicates and drops blank event names, trims an empty tenant to
 * absent, requires `since` (if given) to be a parseable instant, and clamps `limit` into
 * `[1, maxLimit]` (defaulting when absent). Rejects a non-integer/negative limit or an unparseable
 * `since` — fail closed at the boundary rather than passing junk to the store.
 *
 * @param input - The raw query.
 * @param bounds - Optional default / max row caps.
 * @returns The normalized query.
 * @throws Error on a non-positive-integer `limit` or an unparseable `since`.
 */
export function normalizeAuditQuery(
  input: AuditQueryInput,
  bounds: AuditQueryBounds = {},
): NormalizedAuditQuery {
  const defaultLimit = bounds.defaultLimit ?? DEFAULT_LIMIT;
  const maxLimit = bounds.maxLimit ?? MAX_LIMIT;

  let limit = input.limit ?? defaultLimit;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`audit query: limit must be a positive integer, got ${String(input.limit)}`);
  }
  if (limit > maxLimit) limit = maxLimit;

  const result: NormalizedAuditQuery = { limit };

  if (input.events !== undefined) {
    const events = [...new Set(input.events.map((e) => e.trim()).filter((e) => e.length > 0))];
    if (events.length > 0) result.events = events;
  }

  if (input.tenantId !== undefined) {
    const tenantId = input.tenantId.trim();
    if (tenantId.length > 0) result.tenantId = tenantId;
  }

  if (input.since !== undefined) {
    if (Number.isNaN(Date.parse(input.since))) {
      throw new Error(`audit query: since must be an ISO-8601 instant, got ${input.since}`);
    }
    result.since = input.since;
  }

  return result;
}
