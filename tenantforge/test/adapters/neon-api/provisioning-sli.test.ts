import { describe, expect, it } from 'vitest';
import { createNeonProvisioningProvider } from '../../../src/adapters/neon-api/provisioning-provider.js';
import { createMetricsEventSink } from '../../../src/adapters/metrics-event-sink.js';
import type { TenantEvent } from '../../../src/core/observability.js';
import type { EventSink } from '../../../src/ports/event-sink.js';

/** A collecting {@link EventSink} for asserting the emitted `neon.api` SLI events. */
function collectingSink(): { sink: EventSink; events: TenantEvent[] } {
  const events: TenantEvent[] = [];
  return { sink: { emit: (e) => events.push(e) }, events };
}

/** A JSON `Response` for a successful create-project call. */
function createProjectResponse(): Response {
  return new Response(
    JSON.stringify({
      project: { id: 'proj-1' },
      connection_uris: [{ connection_uri: 'postgresql://secret@host/db' }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('Neon provider — upstream-dependency SLI (M2)', () => {
  it('emits ONE neon.api ok event with operation, status, attempts, transient on success', async () => {
    const { sink, events } = collectingSink();
    const fetchImpl = (async () => createProjectResponse()) as unknown as typeof fetch;
    const provider = createNeonProvisioningProvider({
      apiKey: 'secret-key',
      orgId: 'org-1',
      fetchImpl,
      eventSink: sink,
    });

    const result = await provider.createTenantProject({ slug: 'acme', region: 'aws-us-east-1' });
    expect(result.neonProjectId).toBe('proj-1');

    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.event).toBe('neon.api');
    expect(ev.outcome).toBe('ok');
    expect(typeof ev.durationMs).toBe('number');
    expect(ev.context).toEqual({
      operation: 'create_project',
      status: 200,
      attempts: 1,
      transient: false,
    });
    // No secret (api key / connection uri) leaks into the event context.
    const serialized = JSON.stringify(ev);
    expect(serialized).not.toContain('secret-key');
    expect(serialized).not.toContain('postgresql://');
  });

  it('emits a single ok event with attempts=2 after a transient 503 is retried then succeeds', async () => {
    const { sink, events } = collectingSink();
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) return new Response('overloaded', { status: 503 });
      return createProjectResponse();
    }) as unknown as typeof fetch;
    const provider = createNeonProvisioningProvider({
      apiKey: 'secret-key',
      orgId: 'org-1',
      fetchImpl,
      eventSink: sink,
    });

    const result = await provider.createTenantProject({ slug: 'acme', region: 'aws-us-east-1' });
    expect(result.neonProjectId).toBe('proj-1');

    // ONE logical call → ONE event, across the retry.
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe('ok');
    expect(events[0]!.context).toEqual({
      operation: 'create_project',
      status: 200,
      attempts: 2,
      transient: false,
    });
  });

  it('emits an error event with the last status, attempts, and transient flag on terminal failure', async () => {
    const { sink, events } = collectingSink();
    const fetchImpl = (async () =>
      new Response('boom', { status: 500 })) as unknown as typeof fetch;
    const provider = createNeonProvisioningProvider({
      apiKey: 'secret-key',
      orgId: 'org-1',
      maxAttempts: 2,
      fetchImpl,
      eventSink: sink,
    });

    await expect(
      provider.createTenantProject({ slug: 'acme', region: 'aws-us-east-1' }),
    ).rejects.toThrow(/HTTP 500/);

    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.outcome).toBe('error');
    expect(ev.context).toEqual({
      operation: 'create_project',
      status: 500,
      attempts: 2,
      transient: true, // exhausted a retryable 5xx
    });
  });

  it('reports status 0 and non-transient for a terminal 4xx caller error (fail fast, no retry)', async () => {
    const { sink, events } = collectingSink();
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      return new Response('bad request', { status: 400 });
    }) as unknown as typeof fetch;
    const provider = createNeonProvisioningProvider({
      apiKey: 'secret-key',
      orgId: 'org-1',
      maxAttempts: 3,
      fetchImpl,
      eventSink: sink,
    });

    await expect(provider.deleteTenantProject('proj-1')).rejects.toThrow(/HTTP 400/);
    // 4xx (non-429) is not retried → exactly one fetch, one error event.
    expect(call).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe('error');
    expect(events[0]!.context).toEqual({
      operation: 'delete_project',
      status: 400,
      attempts: 1,
      transient: false,
    });
  });

  it('reports status 0 (no HTTP response) on a network error', async () => {
    const { sink, events } = collectingSink();
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const provider = createNeonProvisioningProvider({
      apiKey: 'secret-key',
      orgId: 'org-1',
      maxAttempts: 1,
      fetchImpl,
      eventSink: sink,
    });

    await expect(provider.deleteTenantProject('proj-1')).rejects.toThrow(/request failed/);
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe('error');
    expect(events[0]!.context).toEqual({
      operation: 'delete_project',
      status: 0,
      attempts: 1,
      transient: true,
    });
  });

  it('defaults to a no-op sink when none is injected (no throw, no events observable)', async () => {
    const fetchImpl = (async () => createProjectResponse()) as unknown as typeof fetch;
    const provider = createNeonProvisioningProvider({
      apiKey: 'secret-key',
      orgId: 'org-1',
      fetchImpl,
    });
    // Must not throw despite no configured sink.
    await expect(
      provider.createTenantProject({ slug: 'acme', region: 'aws-us-east-1' }),
    ).resolves.toBeDefined();
  });

  it('flows neon.api events end-to-end into the metrics sink render output', async () => {
    const metrics = createMetricsEventSink();
    const fetchImpl = (async () => createProjectResponse()) as unknown as typeof fetch;
    const provider = createNeonProvisioningProvider({
      apiKey: 'secret-key',
      orgId: 'org-1',
      fetchImpl,
      eventSink: metrics,
    });

    await provider.createTenantProject({ slug: 'acme', region: 'aws-us-east-1' });
    const text = metrics.render();
    expect(text).toContain('tenantforge_events_total{event="neon.api",outcome="ok"} 1');
    // The duration histogram series exists for the neon.api dependency-latency SLI.
    expect(text).toContain('tenantforge_event_duration_ms_count{event="neon.api"}');
  });
});
