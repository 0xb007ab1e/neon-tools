import { describe, expect, it } from 'vitest';
import type { TenantStatus } from '../../src/core/domain.js';
import { assertTransition, canTransition, isTerminal } from '../../src/core/lifecycle.js';

// The intended transition matrix, declared HERE as the spec (independent of the implementation) so a
// change to the lifecycle that isn't reflected here is caught. Every other (from,to) pair is illegal.
const ALL: TenantStatus[] = ['provisioning', 'active', 'suspended', 'offboarding', 'deleted'];
const LEGAL: Record<TenantStatus, TenantStatus[]> = {
  provisioning: ['active', 'deleted'],
  active: ['suspended', 'offboarding'],
  suspended: ['active', 'offboarding'],
  offboarding: ['active', 'deleted'],
  deleted: [],
};

describe('isTerminal', () => {
  it('is true only for deleted', () => {
    expect(isTerminal('deleted')).toBe(true);
    expect(isTerminal('active')).toBe(false);
    expect(isTerminal('provisioning')).toBe(false);
  });
});

describe('canTransition', () => {
  it('allows the modeled transitions', () => {
    expect(canTransition('provisioning', 'active')).toBe(true);
    expect(canTransition('active', 'suspended')).toBe(true);
    expect(canTransition('suspended', 'active')).toBe(true);
    expect(canTransition('offboarding', 'deleted')).toBe(true);
    expect(canTransition('offboarding', 'active')).toBe(true); // un-archive (restore) during retention
  });

  it('rejects illegal transitions', () => {
    expect(canTransition('active', 'deleted')).toBe(false);
    expect(canTransition('deleted', 'active')).toBe(false);
    expect(canTransition('provisioning', 'suspended')).toBe(false);
  });
});

describe('assertTransition', () => {
  it('passes for a legal transition', () => {
    expect(() => assertTransition('active', 'offboarding')).not.toThrow();
  });

  it('throws for an illegal transition', () => {
    expect(() => assertTransition('active', 'deleted')).toThrow(/illegal tenant status transition/);
  });
});

// Exhaustive: assert EVERY (from,to) pair in the 5×5 matrix matches the spec — no illegal transition
// is silently permitted, and every modeled one is allowed. This is the make-illegal-states-
// unrepresentable guarantee for the tenant lifecycle (topic-state-management).
describe('transition matrix (exhaustive)', () => {
  for (const from of ALL) {
    for (const to of ALL) {
      const legal = LEGAL[from].includes(to);
      it(`${from} → ${to} is ${legal ? 'allowed' : 'rejected'}`, () => {
        expect(canTransition(from, to)).toBe(legal);
        if (legal) {
          expect(() => assertTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertTransition(from, to)).toThrow(/illegal tenant status transition/);
        }
      });
    }
  }
});
