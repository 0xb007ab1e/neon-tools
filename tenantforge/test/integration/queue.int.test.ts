import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgTenantRegistry } from '../../src/adapters/neon-pg/registry.js';
import { createPgMessageQueue } from '../../src/adapters/neon-pg/message-queue.js';
import { createLifecycleConsumer } from '../../src/adapters/lifecycle-consumer.js';
import type { LifecycleCommand } from '../../src/adapters/lifecycle-command.js';

// Non-hermetic: needs only a live control-plane Postgres (no Neon API). Self-skips without it.
const databaseUrl = process.env.DATABASE_URL;
const ready = Boolean(databaseUrl);

describe.skipIf(!ready)('pg message queue (live Postgres)', () => {
  const registry = createPgTenantRegistry({ connectionString: databaseUrl! });
  // Short visibility timeout so the redelivery assertion doesn't slow the suite.
  const queue = createPgMessageQueue({ connectionString: databaseUrl!, visibilityTimeoutMs: 500 });
  const cleanup = new Pool({ connectionString: databaseUrl! });

  beforeAll(async () => {
    await registry.migrate(); // ensures tf_lifecycle_queue exists
    await cleanup.query('TRUNCATE tf_lifecycle_queue');
  });

  afterAll(async () => {
    await cleanup.query('TRUNCATE tf_lifecycle_queue');
    await cleanup.end();
    await queue.close();
  });

  it('enqueues, claims with a visibility timeout, and acks', async () => {
    const id = await queue.enqueue({ id: 'cmd-1', type: 'suspend', tenantId: 't-1' });
    expect(id).toBeTruthy();

    const first = await queue.receive(10);
    expect(first).toHaveLength(1);
    expect(first[0]!.body).toMatchObject({ id: 'cmd-1', type: 'suspend' });

    // Immediately re-claiming returns nothing — the row is hidden for the visibility window.
    expect(await queue.receive(10)).toHaveLength(0);

    await queue.ack(first[0]!.id);
    // After redelivery would have been possible, the acked row is gone for good.
    await new Promise((r) => setTimeout(r, 600));
    expect(await queue.receive(10)).toHaveLength(0);
  });

  it('redelivers an unacked message after the visibility timeout', async () => {
    await queue.enqueue({ id: 'cmd-2', type: 'resume', tenantId: 't-2' });
    const claimed = await queue.receive(10);
    expect(claimed).toHaveLength(1);

    await new Promise((r) => setTimeout(r, 600)); // let the visibility window lapse
    const redelivered = await queue.receive(10);
    expect(redelivered).toHaveLength(1);
    await queue.ack(redelivered[0]!.id);
  });

  it('drains via the consumer and dead-letters invalid payloads', async () => {
    const handled: LifecycleCommand[] = [];
    const consumer = createLifecycleConsumer({
      queue,
      handle: async (command) => {
        handled.push(command);
      },
    });

    await queue.enqueue({ id: 'cmd-3', type: 'offboard', tenantId: 't-3' });
    await queue.enqueue({ id: 'cmd-3', type: 'offboard', tenantId: 't-3' }); // duplicate id
    await queue.enqueue({ not: 'a valid command' }); // dead-letter

    const report = await consumer.drain();
    expect(report.processed).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.deadLettered).toBe(1);
    expect(handled).toHaveLength(1);

    const { rows } = await cleanup.query<{ status: string }>(
      "SELECT status FROM tf_lifecycle_queue WHERE status = 'dead'",
    );
    expect(rows).toHaveLength(1);
  });
});
