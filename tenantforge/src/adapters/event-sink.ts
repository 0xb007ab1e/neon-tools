import type { TenantEvent } from '../core/observability.js';
import type { EventSink } from '../ports/event-sink.js';

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
