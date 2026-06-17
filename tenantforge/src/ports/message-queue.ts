/** A message pulled from the lifecycle queue. */
export interface QueueMessage {
  /** Broker message id (used to ack / dead-letter). */
  id: string;
  /** The raw, untrusted command payload (validated before use). */
  body: unknown;
}

/**
 * Port: a queue delivering lifecycle commands (topic-event-driven). Vendor-agnostic — the
 * production adapter is SQS / NATS / Pub/Sub (its own branch); an in-memory adapter backs tests.
 *
 * Delivery is **at-least-once**, so the consumer dedupes by command id and treats handlers as
 * idempotent. `ack` marks a message done; `deadLetter` routes a poison/failed message aside.
 */
export interface MessageQueue {
  /**
   * Pull up to `max` messages (empty array when the queue is drained).
   *
   * @param max - Maximum messages to return.
   * @returns The pulled messages.
   */
  receive(max: number): Promise<QueueMessage[]>;

  /**
   * Acknowledge a successfully-processed message (remove it from the queue).
   *
   * @param messageId - The broker message id.
   */
  ack(messageId: string): Promise<void>;

  /**
   * Route a message to the dead-letter queue (invalid payload or non-retryable failure).
   *
   * @param messageId - The broker message id.
   * @param reason - Why it was dead-lettered (no secrets/PII).
   */
  deadLetter(messageId: string, reason: string): Promise<void>;
}
