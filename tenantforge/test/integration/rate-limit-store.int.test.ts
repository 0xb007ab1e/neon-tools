import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgTenantRegistry } from '../../src/adapters/neon-pg/registry.js';
import { createPgRateLimitStore } from '../../src/adapters/neon-pg/rate-limit-store.js';

// Non-hermetic: needs a live control-plane Postgres (no Neon API). Self-skips without DATABASE_URL.
const databaseUrl = process.env.DATABASE_URL;
const ready = Boolean(databaseUrl);

describe.skipIf(!ready)('pg rate-limit store (live Postgres)', () => {
  const registry = createPgTenantRegistry({ connectionString: databaseUrl! });
  const store = createPgRateLimitStore({ connectionString: databaseUrl! });
  const cleanup = new Pool({ connectionString: databaseUrl! });
  const tag = Date.now().toString(36);
  const key = `rl-${tag}`;

  beforeAll(async () => {
    await registry.migrate(); // ensures tf_rate_limits (migration 0004)
    await cleanup.query('DELETE FROM tf_rate_limits WHERE key LIKE $1', ['rl-%']);
  });

  afterAll(async () => {
    await cleanup.query('DELETE FROM tf_rate_limits WHERE key LIKE $1', ['rl-%']);
    await cleanup.end();
    await store.close();
    await registry.close();
  });

  it('counts within a window and resets on rollover', async () => {
    expect(await store.increment(key, 1000, 0)).toEqual({ count: 1, windowStartMs: 0 });
    expect(await store.increment(key, 1000, 500)).toEqual({ count: 2, windowStartMs: 0 });
    expect(await store.increment(key, 1000, 1000)).toEqual({ count: 1, windowStartMs: 1000 });
  });

  it('shares the count across separate store instances (cross-instance global limit)', async () => {
    const k = `rl-shared-${tag}`;
    const a = createPgRateLimitStore({ connectionString: databaseUrl! });
    const b = createPgRateLimitStore({ connectionString: databaseUrl! });
    try {
      expect((await a.increment(k, 1000, 0)).count).toBe(1);
      expect((await b.increment(k, 1000, 0)).count).toBe(2); // sees instance A's hit via the DB
      expect((await a.increment(k, 1000, 0)).count).toBe(3);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
