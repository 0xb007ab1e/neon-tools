import { describe, expect, it } from 'vitest';
import { createPgPendingErasureStore } from '../../src/adapters/neon-pg/pending-erasure-store.js';

// Hermetic unit tests for the Postgres pending-erasure adapter that need NO live DB: they assert the
// fail-closed transport-security guard at construction time. The full behavioral contract (the
// cross-replica atomic claim/cancel, PII clearing, durability) is proven by the integration suite
// against an ephemeral Neon branch — `test/integration/pending-erasure-store.int.test.ts` — because
// it requires real SQL execution. (This adapter file is excluded from the unit coverage denominator;
// it is the imperative shell.)
describe('createPgPendingErasureStore (construction guards)', () => {
  it('fails closed on a non-TLS connection string (no sslmode)', () => {
    expect(() =>
      createPgPendingErasureStore({ connectionString: 'postgres://u:p@host/db' }),
    ).toThrow(/must enforce TLS/);
  });

  it('fails closed when sslmode disables TLS', () => {
    expect(() =>
      createPgPendingErasureStore({ connectionString: 'postgres://u:p@host/db?sslmode=disable' }),
    ).toThrow(/must enforce TLS/);
  });

  it('accepts a TLS-enforcing connection string (sslmode=require)', () => {
    // No query runs at construction time, so this does not open a real connection.
    const store = createPgPendingErasureStore({
      connectionString: 'postgres://u:p@host/db?sslmode=require',
    });
    expect(typeof store.claimForProcessing).toBe('function');
    expect(typeof store.close).toBe('function');
  });

  it('permits a non-TLS connection only with the explicit allowInsecure opt-out (local dev)', () => {
    expect(() =>
      createPgPendingErasureStore({
        connectionString: 'postgres://u:p@host/db',
        allowInsecure: true,
      }),
    ).not.toThrow();
  });
});
