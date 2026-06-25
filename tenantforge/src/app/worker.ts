import { pathToFileURL } from 'node:url';
import type { LifecycleConsumer } from '../adapters/lifecycle-consumer.js';
import { createLifecycleConsumer } from '../adapters/lifecycle-consumer.js';
import { createPgMessageQueue } from '../adapters/neon-pg/message-queue.js';
import { loadConfig } from './config.js';
import { createLifecycleHandler, tenantForgeFromConfig, type TenantForge } from './lib.js';

/** Resolve after `ms`, or immediately if cancelled. */
function sleep(ms: number, signal: { cancelled: boolean }): Promise<void> {
  return new Promise((resolve) => {
    if (signal.cancelled) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Minimal write sink for one worker cycle's diagnostics (so it's testable without process.stderr). */
type WorkerLog = (line: string) => void;

/**
 * Run **one** worker cycle: drain the lifecycle queue, then drain due self-serve erasures. Extracted
 * from the poll loop so the wiring is unit-testable. Both phases are best-effort-reported; the
 * erasure sweep is **always run** (not flag-gated) and wrapped so a sweep failure can never crash the
 * worker — it can only act on records the flag-gated destructive endpoint scheduled, so while
 * `TENANTFORGE_PORTAL_SELFSERVE_DESTRUCTIVE` is off nothing is scheduled and the sweep no-ops. Without
 * it, a scheduled GDPR Art. 17 erasure would never execute (SLA unmeetable).
 *
 * @param consumer - The lifecycle-queue consumer to drain.
 * @param tf - The control-plane facade (provides `erasureSweep`).
 * @param log - Sink for diagnostic lines.
 */
export async function runWorkerCycle(
  consumer: Pick<LifecycleConsumer, 'drain'>,
  tf: Pick<TenantForge, 'erasureSweep'>,
  log: WorkerLog,
): Promise<void> {
  const report = await consumer.drain();
  if (report.processed > 0 || report.deadLettered > 0) {
    log(`tenantforge worker: ${JSON.stringify(report)}\n`);
  }
  try {
    const erasures = await tf.erasureSweep();
    if (erasures.processed.length > 0 || erasures.failed.length > 0) {
      log(`tenantforge worker erasure-sweep: ${JSON.stringify(erasures)}\n`);
    }
  } catch (error) {
    log(
      `tenantforge worker erasure-sweep error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

/**
 * Entry point: drain the Postgres-backed lifecycle queue on a poll loop, applying each command to
 * the control plane. Graceful shutdown on SIGINT/SIGTERM (finish the in-flight drain, then close).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const tf = await tenantForgeFromConfig(config);
  await tf.migrate(); // ensure the queue + registry tables exist
  const queue = createPgMessageQueue({
    connectionString: config.databaseUrl,
    allowInsecure: config.allowInsecureDb,
  });
  const consumer = createLifecycleConsumer({ queue, handle: createLifecycleHandler(tf) });

  const state = { cancelled: false };
  const stop = (): void => {
    state.cancelled = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const log: WorkerLog = (line) => void process.stderr.write(line);
  process.stderr.write(`tenantforge worker started (poll ${config.queuePollMs}ms)\n`);
  while (!state.cancelled) {
    await runWorkerCycle(consumer, tf, log);
    if (state.cancelled) break;
    await sleep(config.queuePollMs, state);
  }

  process.stderr.write('tenantforge worker draining + shutting down\n');
  await queue.close();
  await tf.close();
  process.exit(0);
}

// Only run the poll loop when this module is the program entry point — importing it (e.g. a unit
// test exercising `runWorkerCycle`) must NOT start the loop or touch the DB/process signals.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `tenantforge worker: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
