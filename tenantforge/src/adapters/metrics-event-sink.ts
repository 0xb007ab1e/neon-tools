import type { TenantEvent } from '../core/observability.js';
import type { EventSink } from '../ports/event-sink.js';

/**
 * Cumulative histogram bucket boundaries (ms) for event durations.
 *
 * The high-end boundaries (10 s / 30 s / 60 s) exist so slow control-plane operations — notably
 * `tenant.provisioned` (Neon project creation takes tens of seconds) — have measurable p95/p99
 * instead of collapsing into `+Inf` (M3). Shared by the event and HTTP histograms; HTTP requests
 * simply leave the high buckets mostly empty. Backward-compatible: existing boundaries unchanged.
 */
const DURATION_BUCKETS_MS = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000,
] as const;

/** An {@link EventSink} that also renders accumulated RED metrics in Prometheus text format. */
export interface MetricsEventSink extends EventSink {
  /**
   * Observe a completed HTTP request for the per-request RED metrics (control-plane API
   * availability + latency SLIs). Called from the HTTP timing middleware with the **matched route
   * template** (e.g. `/v1/tenants/:id`), never the raw path — the template bounds label cardinality.
   *
   * @param req - The request facts.
   * @param req.method - HTTP method (e.g. `GET`).
   * @param req.route - The matched route template, not the raw URL (cardinality bound).
   * @param req.statusClass - The status class: `2xx` | `3xx` | `4xx` | `5xx`.
   * @param req.durationMs - Wall-clock request duration in ms (from the injected clock).
   */
  observeHttpRequest(req: {
    method: string;
    route: string;
    statusClass: string;
    durationMs: number;
  }): void;
  /** Render the current metrics in Prometheus 0.0.4 text exposition format. */
  render(): string;
}

interface Histogram {
  /** Cumulative counts aligned with {@link DURATION_BUCKETS_MS}. */
  bucketCounts: number[];
  sum: number;
  count: number;
}

/** A counted HTTP request series row (labels + tally), so render never re-parses a composite key. */
interface HttpCounter {
  method: string;
  route: string;
  statusClass: string;
  count: number;
}

/** An HTTP duration histogram keyed by method+route, carrying its labels for stable rendering. */
interface HttpHistogram extends Histogram {
  method: string;
  route: string;
}

/** Escape a Prometheus label value (`\`, `"`, newline). */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** A fresh, zeroed histogram aligned with {@link DURATION_BUCKETS_MS}. */
function newHistogram(): Histogram {
  return { bucketCounts: DURATION_BUCKETS_MS.map(() => 0), sum: 0, count: 0 };
}

/** Accumulate one observation into a histogram (cumulative buckets + sum + count). */
function observe(hist: Histogram, durationMs: number): void {
  hist.sum += durationMs;
  hist.count += 1;
  DURATION_BUCKETS_MS.forEach((boundary, i) => {
    if (durationMs <= boundary) hist.bucketCounts[i]! += 1;
  });
}

/**
 * Create a {@link MetricsEventSink} that derives **RED metrics** (rate / errors / duration) from the
 * control-plane event stream and exposes them in Prometheus text format — no new dependency, and no
 * scattered instrumentation: the same {@link TenantEvent}s that feed logs feed metrics
 * (topic-logging-observability). Compose it alongside the JSON sink with
 * {@link import('./event-sink.js').createFanOutEventSink} and serve `render()` at `GET /metrics`.
 *
 * Emits four series:
 * - `tenantforge_events_total{event,outcome}` — a counter (rate + error rate).
 * - `tenantforge_event_duration_ms{event}` — a histogram of event durations (when `durationMs` is set).
 * - `tenantforge_http_requests_total{method,route,status_class}` — a per-request counter
 *   (control-plane API availability SLI); fed by {@link MetricsEventSink.observeHttpRequest}.
 * - `tenantforge_http_request_duration_ms{method,route}` — a per-request latency histogram.
 *
 * Output is deterministically ordered (sorted keys) so it is stable and testable.
 *
 * @returns A metrics-accumulating event sink.
 */
export function createMetricsEventSink(): MetricsEventSink {
  // Counter keyed by `${event} ${outcome}`; histogram keyed by event.
  const counts = new Map<string, number>();
  const durations = new Map<string, Histogram>();
  // HTTP request counter keyed by `${method} ${route} ${statusClass}` and histogram keyed by
  // `${method} ${route}`. The structured labels live in each VALUE so render never re-parses a
  // composite key (a route template could in principle contain a space — parsing would be ambiguous).
  const httpCounts = new Map<string, HttpCounter>();
  const httpDurations = new Map<string, HttpHistogram>();

  return {
    // Non-throwing by construction (only Map ops + arithmetic on a well-typed event), so it satisfies
    // the best-effort EventSink contract without a catch; fan-out isolation guards anything unexpected.
    emit(event: TenantEvent): void {
      const key = `${event.event} ${event.outcome}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (event.durationMs !== undefined) {
        let hist = durations.get(event.event);
        if (hist === undefined) {
          hist = newHistogram();
          durations.set(event.event, hist);
        }
        observe(hist, event.durationMs);
      }
    },

    // Non-throwing by construction (Map ops + arithmetic on already-typed args). The caller passes
    // the matched ROUTE TEMPLATE (not the raw path), so label cardinality stays bounded.
    observeHttpRequest(req): void {
      const { method, route, statusClass, durationMs } = req;
      const counterKey = `${method} ${route} ${statusClass}`;
      const counter = httpCounts.get(counterKey);
      if (counter === undefined) {
        httpCounts.set(counterKey, { method, route, statusClass, count: 1 });
      } else {
        counter.count += 1;
      }

      const histKey = `${method} ${route}`;
      let hist = httpDurations.get(histKey);
      if (hist === undefined) {
        hist = { method, route, ...newHistogram() };
        httpDurations.set(histKey, hist);
      }
      observe(hist, durationMs);
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

      // Per-request HTTP RED metrics (control-plane API availability + latency SLIs). Sorted by the
      // composite key for deterministic, testable output.
      lines.push(
        '# HELP tenantforge_http_requests_total HTTP requests by method, route template, and status class.',
      );
      lines.push('# TYPE tenantforge_http_requests_total counter');
      for (const key of [...httpCounts.keys()].sort()) {
        const c = httpCounts.get(key)!;
        lines.push(
          `tenantforge_http_requests_total{method="${escapeLabel(c.method)}",route="${escapeLabel(c.route)}",status_class="${escapeLabel(c.statusClass)}"} ${c.count}`,
        );
      }

      lines.push(
        '# HELP tenantforge_http_request_duration_ms HTTP request duration in ms by method and route template.',
      );
      lines.push('# TYPE tenantforge_http_request_duration_ms histogram');
      for (const key of [...httpDurations.keys()].sort()) {
        const hist = httpDurations.get(key)!;
        const method = escapeLabel(hist.method);
        const route = escapeLabel(hist.route);
        DURATION_BUCKETS_MS.forEach((boundary, i) => {
          lines.push(
            `tenantforge_http_request_duration_ms_bucket{method="${method}",route="${route}",le="${boundary}"} ${hist.bucketCounts[i]!}`,
          );
        });
        lines.push(
          `tenantforge_http_request_duration_ms_bucket{method="${method}",route="${route}",le="+Inf"} ${hist.count}`,
        );
        lines.push(
          `tenantforge_http_request_duration_ms_sum{method="${method}",route="${route}"} ${hist.sum}`,
        );
        lines.push(
          `tenantforge_http_request_duration_ms_count{method="${method}",route="${route}"} ${hist.count}`,
        );
      }

      return `${lines.join('\n')}\n`;
    },
  };
}
