import { createLifecycleConsumer } from '../adapters/lifecycle-consumer.js';
import { createPgMessageQueue } from '../adapters/neon-pg/message-queue.js';
import { loadConfig } from './config.js';
import { createLifecycleHandler, tenantForgeFromConfig } from './lib.js';

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

/**
 * Entry point: drain the Postgres-backed lifecycle queue on a poll loop, applying each command to
 * the control plane. Graceful shutdown on SIGINT/SIGTERM (finish the in-flight drain, then close).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const tf = tenantForgeFromConfig(config);
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

  process.stderr.write(`tenantforge worker started (poll ${config.queuePollMs}ms)\n`);
  while (!state.cancelled) {
    const report = await consumer.drain();
    if (report.processed > 0 || report.deadLettered > 0) {
      process.stderr.write(`tenantforge worker: ${JSON.stringify(report)}\n`);
    }
    if (state.cancelled) break;
    await sleep(config.queuePollMs, state);
  }

  process.stderr.write('tenantforge worker draining + shutting down\n');
  await queue.close();
  await tf.close();
  process.exit(0);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `tenantforge worker: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
