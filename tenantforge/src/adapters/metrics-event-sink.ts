import type { TenantEvent } from '../core/observability.js';
import type { EventSink } from '../ports/event-sink.js';

/** Cumulative histogram bucket boundaries (ms) for event durations. */
const DURATION_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000] as const;

/** An {@link EventSink} that also renders accumulated RED metrics in Prometheus text format. */
export interface MetricsEventSink extends EventSink {
  /** Render the current metrics in Prometheus 0.0.4 text exposition format. */
  render(): string;
}

interface Histogram {
  /** Cumulative counts aligned with {@link DURATION_BUCKETS_MS}. */
  bucketCounts: number[];
  sum: number;
  count: number;
}

/** Escape a Prometheus label value (`\`, `"`, newline). */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Create a {@link MetricsEventSink} that derives **RED metrics** (rate / errors / duration) from the
 * control-plane event stream and exposes them in Prometheus text format — no new dependency, and no
 * scattered instrumentation: the same {@link TenantEvent}s that feed logs feed metrics
 * (topic-logging-observability). Compose it alongside the JSON sink with
 * {@link import('./event-sink.js').createFanOutEventSink} and serve `render()` at `GET /metrics`.
 *
 * Emits two series:
 * - `tenantforge_events_total{event,outcome}` — a counter (rate + error rate).
 * - `tenantforge_event_duration_ms{event}` — a histogram of event durations (when `durationMs` is set).
 *
 * Output is deterministically ordered (sorted keys) so it is stable and testable.
 *
 * @returns A metrics-accumulating event sink.
 */
export function createMetricsEventSink(): MetricsEventSink {
  // Counter keyed by `${event} ${outcome}`; histogram keyed by event.
  const counts = new Map<string, number>();
  const durations = new Map<string, Histogram>();

  return {
    // Non-throwing by construction (only Map ops + arithmetic on a well-typed event), so it satisfies
    // the best-effort EventSink contract without a catch; fan-out isolation guards anything unexpected.
    emit(event: TenantEvent): void {
      const key = `${event.event} ${event.outcome}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (event.durationMs !== undefined) {
        let hist = durations.get(event.event);
        if (hist === undefined) {
          hist = { bucketCounts: DURATION_BUCKETS_MS.map(() => 0), sum: 0, count: 0 };
          durations.set(event.event, hist);
        }
        hist.sum += event.durationMs;
        hist.count += 1;
        DURATION_BUCKETS_MS.forEach((boundary, i) => {
          if (event.durationMs! <= boundary) hist.bucketCounts[i]! += 1;
        });
      }
    },

    render(): string {
      const lines: string[] = [];

      lines.push('# HELP tenantforge_events_total Control-plane events by name and outcome.');
      lines.push('# TYPE tenantforge_events_total counter');
      for (const key of [...counts.keys()].sort()) {
        const [event, outcome] = key.split(' ') as [string, string];
        lines.push(
          `tenantforge_events_total{event="${escapeLabel(event)}",outcome="${escapeLabel(outcome)}"} ${counts.get(key)!}`,
        );
      }

      lines.push('# HELP tenantforge_event_duration_ms Event handling duration in ms by event.');
      lines.push('# TYPE tenantforge_event_duration_ms histogram');
      for (const event of [...durations.keys()].sort()) {
        const hist = durations.get(event)!;
        const label = escapeLabel(event);
        DURATION_BUCKETS_MS.forEach((boundary, i) => {
          lines.push(
            `tenantforge_event_duration_ms_bucket{event="${label}",le="${boundary}"} ${hist.bucketCounts[i]!}`,
          );
        });
        lines.push(
          `tenantforge_event_duration_ms_bucket{event="${label}",le="+Inf"} ${hist.count}`,
        );
        lines.push(`tenantforge_event_duration_ms_sum{event="${label}"} ${hist.sum}`);
        lines.push(`tenantforge_event_duration_ms_count{event="${label}"} ${hist.count}`);
      }

      return `${lines.join('\n')}\n`;
    },
  };
}
