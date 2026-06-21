import { describe, expect, it } from 'vitest';
import { normalizeAuditQuery } from '../../src/core/audit-query.js';

describe('normalizeAuditQuery', () => {
  it('applies the default limit and omits absent filters', () => {
    expect(normalizeAuditQuery({})).toEqual({ limit: 50 });
  });

  it('honors a custom default + max bound', () => {
    expect(normalizeAuditQuery({}, { defaultLimit: 10 }).limit).toBe(10);
    expect(normalizeAuditQuery({ limit: 9999 }, { maxLimit: 100 }).limit).toBe(100);
  });

  it('de-duplicates and drops blank event names', () => {
    expect(
      normalizeAuditQuery({ events: ['tenant.charged', ' tenant.charged ', '', '  ', 'x'] }).events,
    ).toEqual(['tenant.charged', 'x']);
  });

  it('drops an events filter that is entirely blank', () => {
    expect(normalizeAuditQuery({ events: ['', '  '] }).events).toBeUndefined();
  });

  it('trims tenantId and drops it when empty', () => {
    expect(normalizeAuditQuery({ tenantId: '  t1 ' }).tenantId).toBe('t1');
    expect(normalizeAuditQuery({ tenantId: '   ' }).tenantId).toBeUndefined();
  });

  it('accepts a parseable since and rejects junk', () => {
    expect(normalizeAuditQuery({ since: '2026-06-01T00:00:00.000Z' }).since).toBe(
      '2026-06-01T00:00:00.000Z',
    );
    expect(() => normalizeAuditQuery({ since: 'not-a-date' })).toThrow(/since must be/);
  });

  it('rejects a non-positive-integer limit', () => {
    expect(() => normalizeAuditQuery({ limit: 0 })).toThrow(/positive integer/);
    expect(() => normalizeAuditQuery({ limit: 1.5 })).toThrow(/positive integer/);
    expect(() => normalizeAuditQuery({ limit: -3 })).toThrow(/positive integer/);
  });
});
