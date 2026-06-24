import { describe, expect, it } from 'vitest';
import { canRevealConnection } from '../../src/core/signup-request.js';
import type { SignupRequestRecord } from '../../src/core/signup-request.js';

const base: SignupRequestRecord = {
  id: 's1',
  email: 'new@example.com',
  status: 'active',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
};

describe('canRevealConnection', () => {
  it('allows reveal when active and not yet revealed', () => {
    expect(canRevealConnection(base)).toBe(true);
  });

  it('forbids reveal once already revealed (one-time)', () => {
    expect(canRevealConnection({ ...base, connectionRevealedAt: '2026-06-02T00:00:00.000Z' })).toBe(
      false,
    );
  });

  it('forbids reveal before the tenant is active', () => {
    for (const status of [
      'started',
      'email_verified',
      'payment_ready',
      'provisioning',
      'failed',
    ] as const) {
      expect(canRevealConnection({ ...base, status })).toBe(false);
    }
  });
});
