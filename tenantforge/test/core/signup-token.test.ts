import { describe, expect, it } from 'vitest';
import { assertRedeemable, signupTokenStatus } from '../../src/core/signup-token.js';
import type { SignupTokenRecord } from '../../src/core/signup-token.js';

const base: SignupTokenRecord = {
  tokenHash: 'abc',
  slug: 'acme',
  expiresAt: '2026-07-01T00:00:00.000Z',
  createdAt: '2026-06-01T00:00:00.000Z',
};
const before = '2026-06-15T00:00:00.000Z';
const after = '2026-07-02T00:00:00.000Z';

describe('signupTokenStatus', () => {
  it('is pending before expiry and unredeemed', () => {
    expect(signupTokenStatus(base, before)).toBe('pending');
  });

  it('is expired at/after expiry when unredeemed', () => {
    expect(signupTokenStatus(base, after)).toBe('expired');
    expect(signupTokenStatus(base, base.expiresAt)).toBe('expired'); // boundary: now >= expiresAt
  });

  it('is redeemed once consumed, regardless of expiry', () => {
    const redeemed = { ...base, redeemedAt: before, redeemedTenantId: 't1' };
    expect(signupTokenStatus(redeemed, before)).toBe('redeemed');
    expect(signupTokenStatus(redeemed, after)).toBe('redeemed');
  });
});

describe('assertRedeemable', () => {
  it('passes for a pending token', () => {
    expect(() => assertRedeemable(base, before)).not.toThrow();
  });

  it('throws for an expired token', () => {
    expect(() => assertRedeemable(base, after)).toThrow(/expired/);
  });

  it('throws for an already-redeemed token', () => {
    expect(() => assertRedeemable({ ...base, redeemedAt: before }, before)).toThrow(
      /already redeemed/,
    );
  });
});
