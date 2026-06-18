import { describe, expect, it } from 'vitest';
import type { TenantStatus } from '../../src/core/domain.js';
import { assertRoutable, type RoutableTenant } from '../../src/core/routing.js';

const base: RoutableTenant = { id: 't1', status: 'active', neonProjectId: 'proj-1' };

describe('assertRoutable', () => {
  it('returns the project id for an active, provisioned tenant', () => {
    expect(assertRoutable(base)).toBe('proj-1');
  });

  // Exhaustive: EVERY non-active status must be non-routable (fail closed). `active` is the only
  // status allowed to receive traffic — a regression making any other routable is a leak vector.
  const NON_ACTIVE: TenantStatus[] = ['provisioning', 'suspended', 'offboarding', 'deleted'];
  it.each(NON_ACTIVE)('fails closed for a %s tenant', (status) => {
    expect(() => assertRoutable({ ...base, status })).toThrow(/not routable/);
  });

  it('fails closed for an active tenant with no provisioned project', () => {
    expect(() => assertRoutable({ ...base, neonProjectId: null })).toThrow(
      /no provisioned project/,
    );
  });
});
