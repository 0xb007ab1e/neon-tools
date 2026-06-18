import type { MessageQueue, QueueMessage } from '../../ports/message-queue.js';

// --- A minimal Pub/Sub client surface (the calls this adapter uses) ----------------------------
// Zero-dependency by design: the `@google-cloud/pubsub` client satisfies this via a tiny shim (it
// base64-decodes message data to a string and unwraps gax tuples), so we don't pull the SDK tree in.
// Wire it at the composition root, e.g.:
//   const ps = new PubSub();
//   const client: PubSubClientLike = {
//     pull: ({ subscription, maxMessages }) =>
//       ps.subscription(subscription) /* via the v1 SubscriberClient.pull */ ... ,
//     acknowledge: ({ subscription, ackIds }) => sub.acknowledge(ackIds),
//     modifyAckDeadline: ({ subscription, ackIds, seconds }) => sub.modifyAckDeadline(ackIds, seconds),
//     publish: ({ topic, data }) => ps.topic(topic).publishMessage({ data: Buffer.from(data) }),
//   };

/** A single pulled Pub/Sub message (decoded). */
export interface PubSubPulledMessage {
  /** The ack id used to acknowledge / nack this delivery. */
  ackId: string;
  /** The message data, decoded to a string (the shim base64-decodes Pub/Sub's bytes). */
  data: string;
}

/** The narrow Pub/Sub client this adapter depends on (the `@google-cloud/pubsub` SDK satisfies it). */
export interface PubSubClientLike {
  /** Pull up to `maxMessages` from the subscription. */
  pull(input: { subscription: string; maxMessages: number }): Promise<PubSubPulledMessage[]>;
  /** Acknowledge (remove) the given ack ids. */
  acknowledge(input: { subscription: string; ackIds: string[] }): Promise<void>;
  /** Change the ack deadline (0 = nack → immediate redelivery). */
  modifyAckDeadline(input: {
    subscription: string;
    ackIds: string[];
    seconds: number;
  }): Promise<void>;
  /** Publish a message body to a topic; returns the published message id. */
  publish(input: { topic: string; data: string }): Promise<string>;
}

/** A Pub/Sub-backed {@link MessageQueue}, plus a producer `enqueue`. */
export interface PubSubMessageQueue extends MessageQueue {
  /** Enqueue a command payload (JSON-encoded) to the source topic; returns the message id. */
  enqueue(body: unknown): Promise<string>;
}

/** Options for {@link createPubSubMessageQueue}. */
export interface PubSubMessageQueueOptions {
  /** The narrow Pub/Sub client (wrap your `@google-cloud/pubsub` client). */
  client: PubSubClientLike;
  /** Subscription to pull lifecycle commands from (e.g. `projects/p/subscriptions/s`). */
  subscription: string;
  /** Source topic for {@link PubSubMessageQueue.enqueue} (e.g. `projects/p/topics/t`). */
  topic?: string;
  /**
   * App-level dead-letter topic. When set, {@link MessageQueue.deadLetter} publishes the message
   * there and acks the original. When unset, dead-lettering **nacks** (ack-deadline 0) so the
   * message is redelivered and Pub/Sub's **native dead-letter policy** handles it after
   * `maxDeliveryAttempts`.
   */
  deadLetterTopic?: string;
  /** Max messages per pull. Defaults to 10. */
  maxMessages?: number;
}

/**
 * Create a {@link MessageQueue} backed by **Google Pub/Sub**, over a minimal injected client (so the
 * Google SDK is not a dependency of this project — wrap your client per the shim above). The
 * lifecycle consumer drives it exactly like the SQS / Postgres brokers; Pub/Sub provides the
 * at-least-once delivery the port assumes.
 *
 * `receive` pulls and maps each message to `{ id: ackId, body: <parsed JSON> }` (an unparseable body
 * is passed through as a string so the consumer dead-letters it rather than the batch throwing).
 * `ack` acknowledges the delivery; `deadLetter` publishes to `deadLetterTopic` + acks the original
 * (or, if unset / the body is unknown, **nacks** for Pub/Sub's native dead-letter policy). The
 * irreversible `purge` is never a queue command (defense in depth).
 *
 * @param options - The Pub/Sub client, subscription, and optional topic / DLQ / batch settings.
 * @returns A Pub/Sub-backed message queue.
 */
export function createPubSubMessageQueue(options: PubSubMessageQueueOptions): PubSubMessageQueue {
  const { client, subscription } = options;
  const maxMessages = options.maxMessages ?? 10;
  // Track ackId → raw data so deadLetter() can re-publish the payload to the app DLQ topic.
  const bodies = new Map<string, string>();

  const nack = (ackId: string): Promise<void> =>
    client.modifyAckDeadline({ subscription, ackIds: [ackId], seconds: 0 });

  return {
    async receive(max: number): Promise<QueueMessage[]> {
      const limit = Math.min(Math.max(1, max), maxMessages);
      const pulled = await client.pull({ subscription, maxMessages: limit });
      const out: QueueMessage[] = [];
      for (const message of pulled) {
        bodies.set(message.ackId, message.data);
        let body: unknown = message.data;
        try {
          body = JSON.parse(message.data); // malformed JSON → pass through → consumer dead-letters
        } catch {
          body = message.data;
        }
        out.push({ id: message.ackId, body });
      }
      return out;
    },

    async ack(messageId: string): Promise<void> {
      await client.acknowledge({ subscription, ackIds: [messageId] });
      bodies.delete(messageId);
    },

    async deadLetter(messageId: string, _reason: string): Promise<void> {
      const body = bodies.get(messageId);
      if (options.deadLetterTopic !== undefined && body !== undefined) {
        await client.publish({ topic: options.deadLetterTopic, data: body });
        await client.acknowledge({ subscription, ackIds: [messageId] });
      } else {
        // No app DLQ (or unknown body) → nack so Pub/Sub redelivers + applies its native DLQ policy.
        await nack(messageId);
      }
      bodies.delete(messageId);
    },

    async enqueue(body: unknown): Promise<string> {
      if (options.topic === undefined) {
        throw new Error('PubSubMessageQueue.enqueue: a source topic is required');
      }
      return client.publish({ topic: options.topic, data: JSON.stringify(body) });
    },
  };
}
