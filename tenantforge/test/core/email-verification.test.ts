import { describe, expect, it } from 'vitest';
import {
  assertVerifiable,
  emailVerificationStatus,
  MAX_ATTEMPTS,
} from '../../src/core/email-verification.js';
import type { EmailVerificationRecord } from '../../src/core/email-verification.js';

const base: EmailVerificationRecord = {
  email: 'new@example.com',
  codeHash: 'abc',
  expiresAt: '2026-07-01T00:00:00.000Z',
  attempts: 0,
  createdAt: '2026-06-01T00:00:00.000Z',
};
const before = '2026-06-15T00:00:00.000Z';
const after = '2026-07-02T00:00:00.000Z';

describe('emailVerificationStatus', () => {
  it('is pending before expiry, unverified, under the attempt cap', () => {
    expect(emailVerificationStatus(base, before)).toBe('pending');
  });

  it('is expired at/after expiry when unverified', () => {
    expect(emailVerificationStatus(base, after)).toBe('expired');
    expect(emailVerificationStatus(base, base.expiresAt)).toBe('expired'); // boundary: now >= expiresAt
  });

  it('is locked at/above the attempt cap (anti-brute-force), before expiry', () => {
    expect(emailVerificationStatus({ ...base, attempts: MAX_ATTEMPTS }, before)).toBe('locked');
    expect(emailVerificationStatus({ ...base, attempts: MAX_ATTEMPTS + 1 }, before)).toBe('locked');
  });

  it('is verified once consumed, regardless of expiry or attempts', () => {
    const verified = { ...base, verifiedAt: before, attempts: MAX_ATTEMPTS };
    expect(emailVerificationStatus(verified, before)).toBe('verified');
    expect(emailVerificationStatus(verified, after)).toBe('verified');
  });
});

describe('assertVerifiable', () => {
  it('passes for a pending code', () => {
    expect(() => assertVerifiable(base, before)).not.toThrow();
  });

  it('throws for an expired code', () => {
    expect(() => assertVerifiable(base, after)).toThrow(/expired/);
  });

  it('throws for a locked code (too many attempts)', () => {
    expect(() => assertVerifiable({ ...base, attempts: MAX_ATTEMPTS }, before)).toThrow(
      /too many attempts/,
    );
  });

  it('throws for an already-verified code', () => {
    expect(() => assertVerifiable({ ...base, verifiedAt: before }, before)).toThrow(
      /already verified/,
    );
  });
});
