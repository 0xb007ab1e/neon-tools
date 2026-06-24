import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createInMemoryOneTimeCodeStore } from '../../src/adapters/one-time-code-store.js';

const hash = (code: string): string => createHash('sha256').update(code).digest('hex');
const T0 = 1_000_000;

describe('createInMemoryOneTimeCodeStore', () => {
  it('verifies a correct, unexpired code exactly once (single-use)', async () => {
    const store = createInMemoryOneTimeCodeStore();
    await store.put({
      tenantId: 't-a',
      action: 'cancel',
      codeHash: hash('123456'),
      expiresAtMs: T0 + 1000,
      attempts: 0,
    });
    expect((await store.verify('t-a', 'cancel', hash('123456'), 5, T0)).outcome).toBe('ok');
    // Consumed — a second verify of the same code finds nothing.
    expect((await store.verify('t-a', 'cancel', hash('123456'), 5, T0)).outcome).toBe('not_found');
  });

  it('rejects a code bound to a different action (no cross-action authorization)', async () => {
    const store = createInMemoryOneTimeCodeStore();
    await store.put({
      tenantId: 't-a',
      action: 'cancel',
      codeHash: hash('123456'),
      expiresAtMs: T0 + 1000,
      attempts: 0,
    });
    // A cancel code must NOT verify an erasure.
    expect((await store.verify('t-a', 'erasure', hash('123456'), 5, T0)).outcome).toBe('not_found');
  });

  it('rejects a code for a different tenant', async () => {
    const store = createInMemoryOneTimeCodeStore();
    await store.put({
      tenantId: 't-a',
      action: 'cancel',
      codeHash: hash('123456'),
      expiresAtMs: T0 + 1000,
      attempts: 0,
    });
    expect((await store.verify('t-b', 'cancel', hash('123456'), 5, T0)).outcome).toBe('not_found');
  });

  it('expires a code past its TTL (fail closed)', async () => {
    const store = createInMemoryOneTimeCodeStore();
    await store.put({
      tenantId: 't-a',
      action: 'cancel',
      codeHash: hash('123456'),
      expiresAtMs: T0,
      attempts: 0,
    });
    expect((await store.verify('t-a', 'cancel', hash('123456'), 5, T0)).outcome).toBe('expired');
  });

  it('counts mismatches and locks after maxAttempts', async () => {
    const store = createInMemoryOneTimeCodeStore();
    await store.put({
      tenantId: 't-a',
      action: 'cancel',
      codeHash: hash('123456'),
      expiresAtMs: T0 + 10_000,
      attempts: 0,
    });
    expect((await store.verify('t-a', 'cancel', hash('000000'), 2, T0)).outcome).toBe('mismatch');
    expect((await store.verify('t-a', 'cancel', hash('000000'), 2, T0)).outcome).toBe('mismatch');
    // Over the cap → locked, and the (correct) code no longer works.
    expect((await store.verify('t-a', 'cancel', hash('000000'), 2, T0)).outcome).toBe('locked');
    expect((await store.verify('t-a', 'cancel', hash('123456'), 2, T0)).outcome).toBe('not_found');
  });

  it('clear() drops all stored codes (test helper)', async () => {
    const store = createInMemoryOneTimeCodeStore();
    await store.put({
      tenantId: 't-a',
      action: 'cancel',
      codeHash: hash('123456'),
      expiresAtMs: T0 + 1000,
      attempts: 0,
    });
    store.clear();
    expect((await store.verify('t-a', 'cancel', hash('123456'), 5, T0)).outcome).toBe('not_found');
  });

  it('re-requesting replaces the prior code', async () => {
    const store = createInMemoryOneTimeCodeStore();
    await store.put({
      tenantId: 't-a',
      action: 'cancel',
      codeHash: hash('111111'),
      expiresAtMs: T0 + 1000,
      attempts: 0,
    });
    await store.put({
      tenantId: 't-a',
      action: 'cancel',
      codeHash: hash('222222'),
      expiresAtMs: T0 + 1000,
      attempts: 0,
    });
    expect((await store.verify('t-a', 'cancel', hash('111111'), 5, T0)).outcome).toBe('mismatch');
    expect((await store.verify('t-a', 'cancel', hash('222222'), 5, T0)).outcome).toBe('ok');
  });
});
