import type { TenantEvent } from '../core/observability.js';
import type { EventSink } from '../ports/event-sink.js';
import type { AuditLogStore } from '../ports/audit-log-store.js';

/**
 * Create an {@link EventSink} that writes one JSON object per line (a 12-Factor event stream).
 *
 * Defaults to stdout. Never throws — a serialization/write failure is swallowed so observability
 * can't break the operation. Events are expected to already be redacted by the caller.
 *
 * @param write - Line writer (injectable for testing); defaults to `process.stdout`.
 * @returns A JSON-lines event sink.
 */
export function createJsonEventSink(write?: (line: string) => void): EventSink {
  const out = write ?? ((line: string) => process.stdout.write(line));
  return {
    emit(event: TenantEvent): void {
      try {
        out(`${JSON.stringify(event)}\n`);
      } catch {
        // Best-effort: observability must never break a control-plane operation.
      }
    },
  };
}

/**
 * Create an {@link EventSink} that discards events (the default when none is injected).
 *
 * @returns A no-op event sink.
 */
export function createNoopEventSink(): EventSink {
  return { emit: () => undefined };
}

/**
 * Create an {@link EventSink} that **persists** each event to an {@link AuditLogStore} (the durable,
 * queryable audit trail behind the compliance report). Append is fire-and-forget and best-effort —
 * `emit` must not block or throw (the port contract); a store failure is swallowed (and optionally
 * reported via `onError`). Events are expected to already be redacted by the caller (master §5).
 *
 * @param store - The audit-log store to append to.
 * @param onError - Optional callback for an append failure (e.g. to a fallback log).
 * @returns An event sink that writes to the audit trail.
 */
export function createAuditLogEventSink(
  store: AuditLogStore,
  onError?: (event: TenantEvent, error: unknown) => void,
): EventSink {
  return {
    emit(event: TenantEvent): void {
      void store.append(event).catch((error: unknown) => {
        if (onError !== undefined) onError(event, error);
      });
    },
  };
}

/**
 * Create an {@link EventSink} that fans one event out to several sinks (e.g. JSON-to-stdout **and** a
 * metrics accumulator). Each delivery is best-effort and isolated — a throwing sink never blocks the
 * others or breaks the operation.
 *
 * @param sinks - The downstream sinks, invoked in order.
 * @returns A fan-out event sink.
 */
export function createFanOutEventSink(sinks: readonly EventSink[]): EventSink {
  return {
    emit(event): void {
      for (const sink of sinks) {
        try {
          sink.emit(event);
        } catch {
          // Isolated: one sink failing must not stop the others (observability is best-effort).
        }
      }
    },
  };
}
