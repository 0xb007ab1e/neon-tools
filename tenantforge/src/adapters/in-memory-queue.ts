import type { MessageQueue, QueueMessage } from '../ports/message-queue.js';

/** An in-memory {@link MessageQueue} with helpers for tests/dev (enqueue + inspect). */
export interface InMemoryQueue extends MessageQueue {
  /** Enqueue a raw command payload; returns the generated message id. */
  enqueue(body: unknown): string;
  /** Message ids that were dead-lettered, with their reasons. */
  readonly deadLettered: { id: string; reason: string }[];
}

/**
 * Create an in-memory {@link MessageQueue}.
 *
 * For tests and local development only (not durable, single-process). Production injects a real
 * broker adapter (SQS / NATS / Pub/Sub) behind the same port, in its own branch.
 *
 * @returns An in-memory queue.
 */
export function createInMemoryQueue(): InMemoryQueue {
  const pending = new Map<string, QueueMessage>();
  const deadLettered: { id: string; reason: string }[] = [];
  let seq = 0;

  return {
    deadLettered,
    enqueue(body: unknown): string {
      const id = `msg-${++seq}`;
      pending.set(id, { id, body });
      return id;
    },
    receive(max: number): Promise<QueueMessage[]> {
      return Promise.resolve([...pending.values()].slice(0, max));
    },
    ack(messageId: string): Promise<void> {
      pending.delete(messageId);
      return Promise.resolve();
    },
    deadLetter(messageId: string, reason: string): Promise<void> {
      pending.delete(messageId);
      deadLettered.push({ id: messageId, reason });
      return Promise.resolve();
    },
  };
}
