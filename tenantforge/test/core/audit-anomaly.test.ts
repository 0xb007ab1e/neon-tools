import { describe, expect, it } from 'vitest';
import { detectAuditAnomalies } from '../../src/core/audit-anomaly.js';
import type { TenantEvent } from '../../src/core/observability.js';

const ev = (over: Partial<TenantEvent>): TenantEvent => ({
  event: 'tenant.charged',
  at: '2026-06-01T00:00:00.000Z',
  outcome: 'error',
  ...over,
});

describe('detectAuditAnomalies', () => {
  it('returns nothing when no threshold is crossed', () => {
    expect(detectAuditAnomalies([ev({}), ev({ outcome: 'ok' })])).toEqual([]);
  });

  it('raises an error-spike with distinct event names', () => {
    const events = [
      ...Array.from({ length: 6 }, () => ev({ event: 'tenant.charged' })),
      ...Array.from({ length: 6 }, () => ev({ event: 'tenant.dunning' })),
      ev({ outcome: 'ok' }), // ok events are ignored
    ];
    const found = detectAuditAnomalies(events, {
      errorSpike: 10,
      perActorErrors: 99,
      perTenantErrors: 99,
    });
    expect(found).toEqual([
      { kind: 'error-spike', count: 12, events: ['tenant.charged', 'tenant.dunning'] },
    ]);
  });

  it('raises per-actor and per-tenant clusters, sorted by subject', () => {
    const events = [
      ev({ actor: { id: 'op-b', role: 'admin' }, tenantId: 't1' }),
      ev({ actor: { id: 'op-b', role: 'admin' }, tenantId: 't1' }),
      ev({ actor: { id: 'op-a', role: 'admin' }, tenantId: 't2' }),
    ];
    const found = detectAuditAnomalies(events, {
      errorSpike: 99,
      perActorErrors: 2,
      perTenantErrors: 2,
    });
    expect(found).toEqual([
      { kind: 'actor-errors', subject: 'op-b', count: 2, events: ['tenant.charged'] },
      { kind: 'tenant-errors', subject: 't1', count: 2, events: ['tenant.charged'] },
    ]);
  });

  it('uses sensible defaults (errorSpike 10, per-subject 5)', () => {
    const events = Array.from({ length: 5 }, () =>
      ev({ actor: { id: 'op', role: 'admin' }, tenantId: 't1' }),
    );
    // 5 errors < default errorSpike 10, but = default per-actor/per-tenant 5.
    const found = detectAuditAnomalies(events);
    expect(found.map((f) => f.kind)).toEqual(['actor-errors', 'tenant-errors']);
  });

  it('ignores events with no actor / tenant for the grouped findings', () => {
    const events = Array.from({ length: 5 }, () => ev({})); // no actor, no tenant
    expect(detectAuditAnomalies(events, { perActorErrors: 1, perTenantErrors: 1 })).toEqual([]);
  });
});
