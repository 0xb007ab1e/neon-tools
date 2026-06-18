import { describe, expect, it } from 'vitest';
import {
  can,
  permissionsFor,
  isRole,
  isPermission,
  PERMISSIONS,
  type Permission,
} from '../../src/core/authz.js';

describe('authz', () => {
  it('admin holds every permission', () => {
    for (const p of PERMISSIONS) expect(can({ role: 'admin' }, p)).toBe(true);
  });

  it('operator runs the full reversible lifecycle but cannot purge', () => {
    const grant = { role: 'operator' as const };
    expect(can(grant, 'tenant:read')).toBe(true);
    expect(can(grant, 'tenant:provision')).toBe(true);
    expect(can(grant, 'tenant:suspend')).toBe(true);
    expect(can(grant, 'tenant:offboard')).toBe(true);
    expect(can(grant, 'tenant:purge')).toBe(false); // the irreversible op is admin-only
  });

  it('readonly may only read', () => {
    expect(can({ role: 'readonly' }, 'tenant:read')).toBe(true);
    expect(can({ role: 'readonly' }, 'tenant:provision')).toBe(false);
    expect(can({ role: 'readonly' }, 'tenant:purge')).toBe(false);
  });

  it('an explicit permission set overrides the role default (scope an admin down)', () => {
    const grant = { role: 'admin' as const, permissions: ['tenant:read'] as Permission[] };
    expect(can(grant, 'tenant:read')).toBe(true);
    expect(can(grant, 'tenant:purge')).toBe(false); // explicit set wins over the admin default
    expect([...permissionsFor(grant)]).toEqual(['tenant:read']);
  });

  it('an empty explicit permission set denies everything (fail closed)', () => {
    const grant = { role: 'admin' as const, permissions: [] as Permission[] };
    for (const p of PERMISSIONS) expect(can(grant, p)).toBe(false);
  });

  it('an unknown role grants nothing (deny by default)', () => {
    expect(can({ role: 'superuser' as never }, 'tenant:read')).toBe(false);
    expect([...permissionsFor({ role: 'nope' as never })]).toEqual([]);
  });

  it('validates roles and permissions at the boundary', () => {
    expect(isRole('admin')).toBe(true);
    expect(isRole('operator')).toBe(true);
    expect(isRole('superuser')).toBe(false);
    expect(isRole(123)).toBe(false);
    expect(isPermission('tenant:purge')).toBe(true);
    expect(isPermission('tenant:nuke')).toBe(false);
    expect(isPermission(null)).toBe(false);
  });
});
