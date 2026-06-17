import type { TenantEvent } from '../core/observability.js';

/**
 * Port: receives structured, tenant-scoped control-plane events (per-tenant observability).
 *
 * `emit` is **synchronous, best-effort, and must never throw** — observability must not block or
 * break a control-plane operation. The production adapter writes a JSON event stream to stdout
 * (12-Factor); a metrics/SIEM backend can implement the same port later.
 */
export interface EventSink {
  /**
   * Record an event. Must not throw; a failing sink is swallowed by the caller.
   *
   * @param event - The (already-redacted) tenant event.
   */
  emit(event: TenantEvent): void;
}
