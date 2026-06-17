import { describe, expect, it } from 'vitest';
import type { LifecycleCommand } from '../../src/adapters/lifecycle-command.js';
import { createInMemoryQueue } from '../../src/adapters/in-memory-queue.js';
import { createLifecycleConsumer } from '../../src/adapters/lifecycle-consumer.js';

describe('createLifecycleConsumer.drain', () => {
  it('processes valid commands and acks them', async () => {
    const queue = createInMemoryQueue();
    queue.enqueue({ id: 'c1', type: 'provision', slug: 'acme' });
    queue.enqueue({ id: 'c2', type: 'suspend', tenantId: 't1' });
    const handled: LifecycleCommand[] = [];
    const consumer = createLifecycleConsumer({
      queue,
      handle: (c) => (handled.push(c), Promise.resolve()),
    });

    const report = await consumer.drain();
    expect(report).toEqual({ processed: 2, skipped: 0, deadLettered: 0 });
    expect(handled.map((c) => c.type)).toEqual(['provision', 'suspend']);
    expect(await queue.receive(10)).toEqual([]); // all acked
  });

  it('dedupes a redelivered command id (at-least-once)', async () => {
    const queue = createInMemoryQueue();
    queue.enqueue({ id: 'dup', type: 'suspend', tenantId: 't1' });
    queue.enqueue({ id: 'dup', type: 'suspend', tenantId: 't1' });
    let calls = 0;
    const consumer = createLifecycleConsumer({
      queue,
      handle: () => ((calls += 1), Promise.resolve()),
    });
    const report = await consumer.drain();
    expect(report).toMatchObject({ processed: 1, skipped: 1 });
    expect(calls).toBe(1);
  });

  it('dead-letters an invalid payload (poison) without throwing', async () => {
    const queue = createInMemoryQueue();
    queue.enqueue({ nonsense: true });
    const consumer = createLifecycleConsumer({ queue, handle: () => Promise.resolve() });
    const report = await consumer.drain();
    expect(report.deadLettered).toBe(1);
    expect(queue.deadLettered[0]?.reason).toMatch(/invalid lifecycle command/);
  });

  it('isolates a handler failure: dead-letters that message, keeps processing others', async () => {
    const queue = createInMemoryQueue();
    queue.enqueue({ id: 'bad', type: 'suspend', tenantId: 'boom' });
    queue.enqueue({ id: 'good', type: 'suspend', tenantId: 't2' });
    const consumer = createLifecycleConsumer({
      queue,
      handle: (c) =>
        c.type === 'suspend' && c.tenantId === 'boom'
          ? Promise.reject(new Error('illegal transition'))
          : Promise.resolve(),
    });
    const report = await consumer.drain();
    expect(report).toMatchObject({ processed: 1, deadLettered: 1 });
    expect(queue.deadLettered).toEqual([{ id: expect.any(String), reason: 'illegal transition' }]);
  });

  it('dead-letters a non-Error handler rejection (stringified)', async () => {
    const queue = createInMemoryQueue();
    queue.enqueue({ id: 'x', type: 'suspend', tenantId: 't1' });
    const consumer = createLifecycleConsumer({
      queue,
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      handle: () => Promise.reject('raw failure'),
    });
    const report = await consumer.drain();
    expect(report.deadLettered).toBe(1);
    expect(queue.deadLettered[0]?.reason).toBe('raw failure');
  });

  it('returns zeros for an empty queue', async () => {
    const report = await createLifecycleConsumer({
      queue: createInMemoryQueue(),
      handle: () => Promise.resolve(),
    }).drain();
    expect(report).toEqual({ processed: 0, skipped: 0, deadLettered: 0 });
  });
});
