import type { TenantEvent } from '../core/observability.js';

/** A filter for {@link AuditLogStore.query}; results are newest-first, capped at `limit`. */
export interface AuditQuery {
  /** Restrict to these event names (e.g. `tenant.transition`); omitted = any event. */
  events?: readonly string[];
  /** Restrict to one tenant; omitted = all tenants (incl. fleet-level events). */
  tenantId?: string;
  /** Only events at/after this instant (ISO-8601 UTC); omitted = no lower bound. */
  since?: string;
  /** Maximum rows to return (required — queries are always bounded). */
  limit: number;
}

/**
 * Port: a **persisted, append-only audit trail** of control-plane events (who-did-what-when —
 * NIST AU, SOC2 change management, OWASP A09). The {@link EventSink} stream is ephemeral (stdout);
 * this store keeps a queryable record so the compliance report can attest **erasure history** and a
 * **recent audit excerpt** (topic-logging-observability, master §5 — events are already redacted).
 *
 * Append is best-effort from the sink (observability must never block/break an operation); the
 * record is therefore not a guaranteed-complete ledger, but a durable, queryable trail.
 */
export interface AuditLogStore {
  /**
   * Append one (already-redacted) event to the trail.
   *
   * @param event - The tenant event to persist.
   */
  append(event: TenantEvent): Promise<void>;
  /**
   * Query the trail, newest-first.
   *
   * @param query - Event-name / tenant / since filters and a row cap.
   * @returns Matching events, most-recent first.
   */
  query(query: AuditQuery): Promise<TenantEvent[]>;
}
