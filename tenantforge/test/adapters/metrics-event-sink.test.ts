import { describe, expect, it } from 'vitest';
import type { TenantEvent } from '../../src/core/observability.js';
import { createMetricsEventSink } from '../../src/adapters/metrics-event-sink.js';

function ev(overrides: Partial<TenantEvent>): TenantEvent {
  return {
    event: 'tenant.provisioned',
    at: '2026-06-18T00:00:00.000Z',
    outcome: 'ok',
    ...overrides,
  };
}

describe('createMetricsEventSink', () => {
  it('counts events by name and outcome (sorted, Prometheus counter)', () => {
    const m = createMetricsEventSink();
    m.emit(ev({ event: 'tenant.provisioned', outcome: 'ok' }));
    m.emit(ev({ event: 'tenant.provisioned', outcome: 'ok' }));
    m.emit(ev({ event: 'tenant.provisioned', outcome: 'error' }));
    const text = m.render();

    expect(text).toContain('# TYPE tenantforge_events_total counter');
    expect(text).toContain(
      'tenantforge_events_total{event="tenant.provisioned",outcome="error"} 1',
    );
    expect(text).toContain('tenantforge_events_total{event="tenant.provisioned",outcome="ok"} 2');
    // error line sorts before ok line (deterministic ordering).
    expect(text.indexOf('outcome="error"')).toBeLessThan(text.indexOf('outcome="ok"'));
  });

  it('builds a cumulative duration histogram when durationMs is present', () => {
    const m = createMetricsEventSink();
    m.emit(ev({ event: 'tenant.connection_resolved', durationMs: 7 })); // > 5, <= 10
    m.emit(ev({ event: 'tenant.connection_resolved', durationMs: 120 })); // > 100, <= 250
    const text = m.render();

    expect(text).toContain('# TYPE tenantforge_event_duration_ms histogram');
    // le=5: neither observation ≤ 5
    expect(text).toContain(
      'tenantforge_event_duration_ms_bucket{event="tenant.connection_resolved",le="5"} 0',
    );
    // le=10: the 7ms one
    expect(text).toContain(
      'tenantforge_event_duration_ms_bucket{event="tenant.connection_resolved",le="10"} 1',
    );
    // le=250: both
    expect(text).toContain(
      'tenantforge_event_duration_ms_bucket{event="tenant.connection_resolved",le="250"} 2',
    );
    expect(text).toContain(
      'tenantforge_event_duration_ms_bucket{event="tenant.connection_resolved",le="+Inf"} 2',
    );
    expect(text).toContain(
      'tenantforge_event_duration_ms_sum{event="tenant.connection_resolved"} 127',
    );
    expect(text).toContain(
      'tenantforge_event_duration_ms_count{event="tenant.connection_resolved"} 2',
    );
  });

  it('records a counter but no histogram when durationMs is absent', () => {
    const m = createMetricsEventSink();
    m.emit(ev({ event: 'tenant.transition', outcome: 'ok' }));
    const text = m.render();
    expect(text).toContain('tenantforge_events_total{event="tenant.transition",outcome="ok"} 1');
    // No histogram series for an event that never carried a duration.
    expect(text).not.toContain('tenantforge_event_duration_ms_count{event="tenant.transition"}');
  });

  it('escapes special characters in label values', () => {
    const m = createMetricsEventSink();
    m.emit(ev({ event: 'weird"\\\nname', outcome: 'ok' }));
    const text = m.render();
    expect(text).toContain('event="weird\\"\\\\\\nname"');
  });

  it('renders empty metric headers when nothing has been emitted', () => {
    const text = createMetricsEventSink().render();
    expect(text).toContain('# TYPE tenantforge_events_total counter');
    expect(text).toContain('# TYPE tenantforge_event_duration_ms histogram');
  });
});
