import { describe, expect, it } from 'vitest';
import { createInMemoryEmailVerificationStore } from '../../src/adapters/email-verification-store.js';
import type { EmailVerificationRecord } from '../../src/core/index.js';

const rec = (over: Partial<EmailVerificationRecord>): EmailVerificationRecord => ({
  email: 'new@example.com',
  codeHash: 'h1',
  expiresAt: '2026-07-01T00:00:00.000Z',
  attempts: 0,
  createdAt: '2026-06-01T00:00:00.000Z',
  ...over,
});

describe('createInMemoryEmailVerificationStore', () => {
  it('puts, gets by email, and returns null for unknown', async () => {
    const store = createInMemoryEmailVerificationStore();
    await store.put(rec({ email: 'a@example.com', codeHash: 'h1' }));
    expect((await store.get('a@example.com'))?.codeHash).toBe('h1');
    expect(await store.get('nope@example.com')).toBeNull();
  });

  it('re-issuing supersedes the prior code (and resets attempts)', async () => {
    const store = createInMemoryEmailVerificationStore();
    await store.put(rec({ email: 'a@example.com', codeHash: 'old' }));
    await store.recordFailedAttempt('a@example.com');
    await store.put(rec({ email: 'a@example.com', codeHash: 'new', attempts: 0 }));
    const found = await store.get('a@example.com');
    expect(found?.codeHash).toBe('new');
    expect(found?.attempts).toBe(0);
  });

  it('increments failed attempts and returns the new count (0 when unknown)', async () => {
    const store = createInMemoryEmailVerificationStore();
    await store.put(rec({ email: 'a@example.com' }));
    expect(await store.recordFailedAttempt('a@example.com')).toBe(1);
    expect(await store.recordFailedAttempt('a@example.com')).toBe(2);
    expect((await store.get('a@example.com'))?.attempts).toBe(2);
    expect(await store.recordFailedAttempt('unknown@example.com')).toBe(0);
  });

  it('marks an email verified (single-use) and clears', async () => {
    const store = createInMemoryEmailVerificationStore();
    await store.put(rec({ email: 'a@example.com' }));
    await store.markVerified('a@example.com', '2026-06-10T00:00:00.000Z');
    expect((await store.get('a@example.com'))?.verifiedAt).toBe('2026-06-10T00:00:00.000Z');
    store.clear();
    expect(await store.get('a@example.com')).toBeNull();
  });
});
