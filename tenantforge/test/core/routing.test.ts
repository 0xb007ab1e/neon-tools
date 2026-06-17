import { describe, expect, it } from 'vitest';
import { assertRoutable, type RoutableTenant } from '../../src/core/routing.js';

const base: RoutableTenant = { id: 't1', status: 'active', neonProjectId: 'proj-1' };

describe('assertRoutable', () => {
  it('returns the project id for an active, provisioned tenant', () => {
    expect(assertRoutable(base)).toBe('proj-1');
  });

  it('fails closed for a non-active tenant', () => {
    expect(() => assertRoutable({ ...base, status: 'suspended' })).toThrow(/not routable/);
    expect(() => assertRoutable({ ...base, status: 'provisioning' })).toThrow(/not routable/);
    expect(() => assertRoutable({ ...base, status: 'deleted' })).toThrow(/not routable/);
  });

  it('fails closed for an active tenant with no provisioned project', () => {
    expect(() => assertRoutable({ ...base, neonProjectId: null })).toThrow(
      /no provisioned project/,
    );
  });
});
