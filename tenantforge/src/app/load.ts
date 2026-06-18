import { createFleetOrchestrator } from '../adapters/fleet-orchestrator.js';
import type { ConnectionRouter } from '../ports/connection-router.js';
import type { MigrationRunner } from '../ports/migration-runner.js';
import type { TenantRegistry } from '../ports/tenant-registry.js';

/**
 * Load / soak harness for the fleet-migration fan-out — the hottest in-house path (threat-model R3).
 *
 * It drives the real {@link createFleetOrchestrator} over a large synthetic fleet with in-memory
 * fakes, so it measures the **orchestration** (batching, bounded concurrency, failure isolation)
 * without touching Neon. A simulated per-apply latency (`TF_LOAD_APPLY_MS`) models the real
 * per-tenant cost so throughput numbers are meaningful for capacity planning. It is NOT a Neon-API
 * load test — pacing into Neon's real rate limits is the operator-run live profile in
 * `docs/runbooks/scaling.md`.
 *
 * Env: TF_LOAD_TENANTS (default 1000), TF_LOAD_BATCH (10), TF_LOAD_APPLY_MS (0),
 *      TF_LOAD_ITERATIONS (3), TF_LOAD_FAIL_PCT (0).
 * Exits non-zero if observed concurrency ever exceeds the configured batch size (the safety bound).
 */
const num = (name: string, def: number): number => {
  const raw = process.env[name];
  const v = raw === undefined ? def : Number(raw);
  if (!Number.isFinite(v) || v < 0) throw new Error(`${name} must be a non-negative number`);
  return v;
};

const N = Math.max(1, Math.floor(num('TF_LOAD_TENANTS', 1000)));
const BATCH = Math.max(1, Math.floor(num('TF_LOAD_BATCH', 10)));
const APPLY_MS = num('TF_LOAD_APPLY_MS', 0);
const ITERATIONS = Math.max(1, Math.floor(num('TF_LOAD_ITERATIONS', 3)));
const FAIL_PCT = Math.min(100, num('TF_LOAD_FAIL_PCT', 0));

const tenantIds = Array.from({ length: N }, (_, i) => `load-${i}`);
const failEvery = FAIL_PCT > 0 ? Math.max(1, Math.round(100 / FAIL_PCT)) : 0;

const registry = {
  registerMigration: (m: { version: string; checksum: string }) =>
    Promise.resolve({ id: 'load-mig', version: m.version, checksum: m.checksum }),
  list: () => Promise.resolve(tenantIds.map((id) => ({ id }))),
  listTenantMigrationStates: () => Promise.resolve([]),
  recordTenantMigration: () => Promise.resolve(),
} as unknown as TenantRegistry;

const connectionRouter: ConnectionRouter = {
  resolve: (tenantId: string) => Promise.resolve({ tenantId, connectionUri: `uri-${tenantId}` }),
};

let current = 0;
let peak = 0;
const runner: MigrationRunner = {
  applyToTenant: async (connectionUri) => {
    current += 1;
    if (current > peak) peak = current;
    if (APPLY_MS > 0) await new Promise((r) => setTimeout(r, APPLY_MS));
    else await new Promise((r) => setImmediate(r));
    current -= 1;
    if (failEvery > 0) {
      const idx = Number(connectionUri.replace('uri-load-', ''));
      if (idx % failEvery === 0) throw new Error('simulated apply failure');
    }
  },
};

const orchestrator = createFleetOrchestrator({
  registry,
  connectionRouter,
  migrationRunner: runner,
});

async function main(): Promise<void> {
  process.stderr.write(
    `load: tenants=${N} batch=${BATCH} applyMs=${APPLY_MS} iterations=${ITERATIONS} failPct=${FAIL_PCT}\n`,
  );
  let totalMs = 0;
  let overallPeak = 0;
  for (let i = 1; i <= ITERATIONS; i += 1) {
    peak = 0;
    const startedMs = Date.now();
    // Bump the version per iteration so the run is fresh (no already-applied skip).
    const report = await orchestrator.migrateFleet(
      { version: `load_${i}`, sql: 'SELECT 1;' },
      { batchSize: BATCH },
    );
    const elapsedMs = Date.now() - startedMs;
    totalMs += elapsedMs;
    overallPeak = Math.max(overallPeak, peak);
    const tps = elapsedMs > 0 ? Math.round((report.total / elapsedMs) * 1000) : report.total;
    process.stderr.write(
      `  iter ${i}: ${elapsedMs}ms  ~${tps} tenants/s  peak-concurrency=${peak}  ` +
        `succeeded=${report.succeeded.length} failed=${report.failed.length}\n`,
    );
  }
  const avgMs = Math.round(totalMs / ITERATIONS);
  process.stderr.write(
    `load: avg ${avgMs}ms/run  overall peak-concurrency=${overallPeak} (bound=${BATCH})\n`,
  );
  if (overallPeak > BATCH) {
    process.stderr.write(
      `load: FAIL — concurrency ${overallPeak} exceeded the batch bound ${BATCH}\n`,
    );
    process.exit(1);
  }
  process.stderr.write('load: ok — fan-out stayed within the batch bound\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`load: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
