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

    // Snapshot production before rehearsal.
    const before = await vn.models();
    const beforeNames = before.map((m) => m.name).sort();
    const beforeActive = before.find((m) => m.isActive)?.name;

    const report = await vn.rehearse(LARGE);
    expect(report.total).toBeGreaterThan(0);
    expect(report.coverage).toBe(report.total); // fully embedded the corpus on the branch
    expect(report.complete).toBe(true);
    expect(report.branchId.length).toBeGreaterThan(0);
    expect(report.elapsedMs).toBeGreaterThan(0);

    // Production is untouched: rehearsal registered nothing new and did not change the active model.
    const after = await vn.models();
    expect(after.map((m) => m.name).sort()).toEqual(beforeNames);
    expect(after.find((m) => m.isActive)?.name).toBe(beforeActive);
  });
});
