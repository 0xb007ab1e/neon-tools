import { describe, expect, it } from 'vitest';
import { createInMemoryAuditLogStore } from '../../src/adapters/audit-log-store.js';
import { createAuditLogEventSink } from '../../src/adapters/event-sink.js';
import type { TenantEvent } from '../../src/core/observability.js';

const ev = (over: Partial<TenantEvent> & { at: string }): TenantEvent => ({
  event: 'tenant.transition',
  outcome: 'ok',
  ...over,
});

describe('in-memory audit-log store', () => {
  it('returns events newest-first, capped at the limit', async () => {
    const store = createInMemoryAuditLogStore();
    await store.append(ev({ at: '2026-06-01T00:00:00.000Z', tenantId: 'a' }));
    await store.append(ev({ at: '2026-06-03T00:00:00.000Z', tenantId: 'b' }));
    await store.append(ev({ at: '2026-06-02T00:00:00.000Z', tenantId: 'c' }));
    const rows = await store.query({ limit: 2 });
    expect(rows.map((r) => r.tenantId)).toEqual(['b', 'c']);
  });

  it('filters by event name, tenant, and since', async () => {
    const store = createInMemoryAuditLogStore();
    await store.append(
      ev({ at: '2026-06-01T00:00:00.000Z', event: 'tenant.provisioned', tenantId: 'a' }),
    );
    await store.append(
      ev({ at: '2026-06-05T00:00:00.000Z', event: 'tenant.transition', tenantId: 'a' }),
    );
    await store.append(
      ev({ at: '2026-06-05T00:00:00.000Z', event: 'tenant.transition', tenantId: 'b' }),
    );

    expect((await store.query({ events: ['tenant.transition'], limit: 10 })).length).toBe(2);
    expect((await store.query({ tenantId: 'a', limit: 10 })).length).toBe(2);
    expect((await store.query({ since: '2026-06-02T00:00:00.000Z', limit: 10 })).length).toBe(2);
  });

  it('clear() drops all events', async () => {
    const store = createInMemoryAuditLogStore();
    await store.append(ev({ at: '2026-06-01T00:00:00.000Z' }));
    store.clear();
    expect(await store.query({ limit: 10 })).toEqual([]);
  });

  it('the audit event sink persists emitted events (best-effort, never throws)', async () => {
    const store = createInMemoryAuditLogStore();
    const sink = createAuditLogEventSink(store);
    sink.emit(ev({ at: '2026-06-01T00:00:00.000Z', tenantId: 'z' }));
    // append is async/fire-and-forget; let the microtask settle.
    await Promise.resolve();
    const rows = await store.query({ limit: 10 });
    expect(rows[0]?.tenantId).toBe('z');
  });

  it('a failing store does not let the sink throw', async () => {
    const onError = (): void => undefined;
    const failing = {
      append: () => Promise.reject(new Error('boom')),
      query: () => Promise.resolve([]),
    };
    const sink = createAuditLogEventSink(failing, onError);
    expect(() => sink.emit(ev({ at: '2026-06-01T00:00:00.000Z' }))).not.toThrow();
    await Promise.resolve();
  });
});
