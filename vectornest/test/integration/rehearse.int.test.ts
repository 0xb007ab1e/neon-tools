import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPoolConfig } from '../../src/adapters/neon-pg/connection.js';
import { loadConfig } from '../../src/app/config.js';
import { type VectorNest, vectorNestFromConfig } from '../../src/app/lib.js';

// Rehearsal additionally needs the Neon API (to create/delete branches).
const hasCreds =
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.EMBEDDINGS_BASE_URL) &&
  Boolean(process.env.NEON_API_KEY) &&
  Boolean(process.env.NEON_PROJECT_ID);

const fixturesDir = fileURLToPath(new URL('./fixtures', import.meta.url));
const collection = `rehearse_${process.pid}_${Date.now()}`;

describe.skipIf(!hasCreds)('VectorNest branch rehearsal (live Neon API)', () => {
  let vn: VectorNest;

  beforeAll(async () => {
    vn = vectorNestFromConfig(loadConfig());
    await vn.migrate();
    await vn.ingest(fixturesDir, { collection });
  });

  afterAll(async () => {
    if (vn) await vn.close();
    if (hasCreds) {
      const pool = new pg.Pool(buildPoolConfig(process.env.DATABASE_URL ?? ''));
      try {
        await pool.query('DELETE FROM vn_collections WHERE name = $1', [collection]);
      } finally {
        await pool.end();
      }
    }
  });

  it('rehearses a model on a throwaway branch without touching production', async () => {
    const LARGE = '@cf/baai/bge-large-en-v1.5';

    const report = await vn.rehearse(LARGE);
    expect(report.total).toBeGreaterThan(0);
    expect(report.coverage).toBe(report.total);
    expect(report.complete).toBe(true);
    expect(report.branchId.length).toBeGreaterThan(0);
    expect(report.elapsedMs).toBeGreaterThan(0);

    // Production is untouched: the model was registered only on the (now-deleted) branch.
    const prodModels = await vn.models();
    expect(prodModels.find((m) => m.name === LARGE)).toBeUndefined();
    // The configured default model is still the only active one in production.
    expect(prodModels.filter((m) => m.isActive)).toHaveLength(1);
  });
});
