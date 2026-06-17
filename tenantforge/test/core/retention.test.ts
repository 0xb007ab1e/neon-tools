import { describe, expect, it } from 'vitest';
import type { RetainableTenant } from '../../src/core/retention.js';
import { isPurgeable, retentionCutoff } from '../../src/core/retention.js';

const NOW = new Date('2026-06-17T00:00:00Z');

describe('retentionCutoff', () => {
  it('subtracts the retention window from now', () => {
    expect(retentionCutoff(NOW, 30)).toEqual(new Date('2026-05-18T00:00:00Z'));
  });

  it('treats 0 days as the present instant', () => {
    expect(retentionCutoff(NOW, 0)).toEqual(NOW);
  });

  it('rejects a negative retention window', () => {
    expect(() => retentionCutoff(NOW, -1)).toThrow(/must be >= 0/);
  });
});

describe('isPurgeable', () => {
  const cutoff = retentionCutoff(NOW, 30);
  const at = (status: RetainableTenant['status'], updatedAt: string): RetainableTenant => ({
    status,
    updatedAt: new Date(updatedAt),
  });

  it('purges an offboarding tenant archived before the cutoff', () => {
    expect(isPurgeable(at('offboarding', '2026-05-01T00:00:00Z'), cutoff)).toBe(true);
  });

  it('spares an offboarding tenant still within retention', () => {
    expect(isPurgeable(at('offboarding', '2026-06-10T00:00:00Z'), cutoff)).toBe(false);
  });

  it('never sweeps non-offboarding tenants', () => {
    expect(isPurgeable(at('active', '2020-01-01T00:00:00Z'), cutoff)).toBe(false);
    expect(isPurgeable(at('suspended', '2020-01-01T00:00:00Z'), cutoff)).toBe(false);
    expect(isPurgeable(at('deleted', '2020-01-01T00:00:00Z'), cutoff)).toBe(false);
  });
});
