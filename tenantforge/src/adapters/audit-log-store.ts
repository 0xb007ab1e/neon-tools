import type { TenantEvent } from '../core/observability.js';
import type { AuditLogStore, AuditQuery } from '../ports/audit-log-store.js';

/** A process-local {@link AuditLogStore}, plus a `clear` for tests. */
export interface InMemoryAuditLogStore extends AuditLogStore {
  /** Drop all stored events (test helper). */
  clear(): void;
}

/** Whether an event matches the query's filters (event name / tenant / since). */
function matches(event: TenantEvent, query: AuditQuery): boolean {
  if (query.events !== undefined && !query.events.includes(event.event)) return false;
  if (query.tenantId !== undefined && event.tenantId !== query.tenantId) return false;
  if (query.since !== undefined && event.at < query.since) return false;
  return true;
}

/**
 * Create an in-memory {@link AuditLogStore} (process-local, unbounded) — the default trail and the
 * one used in tests. Production uses the Postgres adapter (cross-instance, durable). Sorting is by
 * the event's `at` timestamp, newest-first, then the row cap is applied.
 *
 * @returns An in-memory audit-log store.
 */
export function createInMemoryAuditLogStore(): InMemoryAuditLogStore {
  const events: TenantEvent[] = [];
  return {
    append(event: TenantEvent): Promise<void> {
      events.push(event);
      return Promise.resolve();
    },
    query(query: AuditQuery): Promise<TenantEvent[]> {
      const result = events
        .filter((e) => matches(e, query))
        .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
        .slice(0, query.limit);
      return Promise.resolve(result);
    },
    clear(): void {
      events.length = 0;
    },
  };
}
