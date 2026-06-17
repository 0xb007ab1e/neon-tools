import type { MessageQueue } from '../ports/message-queue.js';
import { parseLifecycleCommand, type LifecycleCommand } from './lifecycle-command.js';

/** Outcome of draining the lifecycle queue. */
export interface ConsumeReport {
  /** Commands handled successfully and acked. */
  processed: number;
  /** Duplicate commands (already-seen id) acked without re-handling. */
  skipped: number;
  /** Messages dead-lettered (invalid payload or handler failure). */
  deadLettered: number;
}

/** Collaborators for {@link createLifecycleConsumer}. */
export interface LifecycleConsumerDeps {
  /** The queue to consume from. */
  queue: MessageQueue;
  /** Applies a validated command (e.g. the TenantForge lifecycle handler). */
  handle: (command: LifecycleCommand) => Promise<void>;
  /** Max messages pulled per batch. Defaults to 10. */
  batchSize?: number;
}

/** Consumes lifecycle commands from a queue. */
export interface LifecycleConsumer {
  /**
   * Process messages until the queue is drained, then return a report. At-least-once safe:
   * duplicate command ids are skipped (deduped within this consumer); invalid payloads and handler
   * failures are dead-lettered (failure-isolated — one bad message never blocks the rest). For a
   * long-running worker, call `drain` on a schedule / loop.
   *
   * @returns Counts of processed / skipped / dead-lettered messages.
   */
  drain(): Promise<ConsumeReport>;
}

/**
 * Create a {@link LifecycleConsumer} from a queue + a command handler.
 *
 * The payload is untrusted: each message is validated by {@link parseLifecycleCommand} (a parse
 * failure is dead-lettered, never thrown). Commands are deduped by id (at-least-once delivery), and
 * a handler error dead-letters just that message.
 *
 * @param deps - Queue, handler, and batch size.
 * @returns A consumer.
 */
export function createLifecycleConsumer(deps: LifecycleConsumerDeps): LifecycleConsumer {
  const { queue, handle } = deps;
  const batchSize = deps.batchSize ?? 10;
  const seen = new Set<string>(); // dedupe by command id (this consumer's lifetime)

  return {
    async drain(): Promise<ConsumeReport> {
      let processed = 0;
      let skipped = 0;
      let deadLettered = 0;
      for (;;) {
        const batch = await queue.receive(batchSize);
        if (batch.length === 0) break;
        for (const message of batch) {
          let command: LifecycleCommand;
          try {
            command = parseLifecycleCommand(message.body);
          } catch {
            await queue.deadLetter(message.id, 'invalid lifecycle command payload');
            deadLettered++;
            continue;
          }
          if (seen.has(command.id)) {
            await queue.ack(message.id); // duplicate (at-least-once) — drop without re-handling
            skipped++;
            continue;
          }
          try {
            await handle(command);
            seen.add(command.id);
            await queue.ack(message.id);
            processed++;
          } catch (error) {
            await queue.deadLetter(
              message.id,
              error instanceof Error ? error.message : String(error),
            );
            deadLettered++;
          }
        }
      }
      return { processed, skipped, deadLettered };
    },
  };
}
