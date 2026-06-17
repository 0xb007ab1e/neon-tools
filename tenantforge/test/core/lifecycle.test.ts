import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition, isTerminal } from '../../src/core/lifecycle.js';

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
