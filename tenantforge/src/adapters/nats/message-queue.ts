import type { MessageQueue, QueueMessage } from '../../ports/message-queue.js';

// --- A minimal NATS JetStream client surface (the calls this adapter uses) ---------------------
// Zero-dependency by design: the `nats` client's JetStream pull consumer satisfies this via a tiny
// shim (decode `msg.data`, map `ack`/`nak`), so we don't pull the SDK tree in. JetStream (not core
// NATS) is required — it provides the at-least-once delivery + per-message ack the port assumes.
// Wire it at the composition root, e.g.:
//   const js = nc.jetstream();
//   const consumer = await js.consumers.get(stream, durable);
//   const client: NatsClientLike = {
//     fetch: async ({ batch }) => {
//       const out = []; const iter = await consumer.fetch({ max_messages: batch });
//       for await (const m of iter) out.push({
//         id: `${m.seq}`, data: sc.decode(m.data),
//         ack: async () => { await m.ackAck(); }, nak: async () => { m.nak(); },
//       });
//       return out;
//     },
//     publish: ({ subject, data }) => js.publish(subject, sc.encode(data)).then(() => {}),
//   };

/** A single pulled JetStream message (decoded), carrying its own ack/nak controls. */
export interface NatsPulledMessage {
  /** A stable per-delivery id (e.g. the stream sequence). */
  id: string;
  /** The message data, decoded to a string. */
  data: string;
  /** Acknowledge (remove) this delivery. */
  ack(): Promise<void>;
  /** Negative-ack → redeliver (JetStream applies `MaxDeliver` + dead-letter advisory). */
  nak(): Promise<void>;
}

/** The narrow JetStream client this adapter depends on (the `nats` consumer satisfies it via a shim). */
export interface NatsClientLike {
  /** Fetch up to `batch` messages from the pull consumer (empty array when drained). */
  fetch(input: { batch: number }): Promise<NatsPulledMessage[]>;
  /** Publish a message body to a subject. */
  publish(input: { subject: string; data: string }): Promise<void>;
}

/** A NATS-backed {@link MessageQueue}, plus a producer `enqueue`. */
export interface NatsMessageQueue extends MessageQueue {
  /** Enqueue a command payload (JSON-encoded) to the source subject; resolves when published. */
  enqueue(body: unknown): Promise<void>;
}

/** Options for {@link createNatsMessageQueue}. */
export interface NatsMessageQueueOptions {
  /** The narrow JetStream client (wrap your `nats` pull consumer + JetStream client). */
  client: NatsClientLike;
  /** Source subject for {@link NatsMessageQueue.enqueue}. */
  subject?: string;
  /**
   * App-level dead-letter subject. When set, {@link MessageQueue.deadLetter} publishes the message
   * there and acks the original. When unset, dead-lettering **nacks** so JetStream redelivers and its
   * native `MaxDeliver` + dead-letter advisory handles it.
   */
  deadLetterSubject?: string;
  /** Max messages per fetch. Defaults to 10. */
  maxMessages?: number;
}

/**
 * Create a {@link MessageQueue} backed by **NATS JetStream**, over a minimal injected client (so the
 * `nats` SDK is not a dependency of this project — wrap your pull consumer per the shim above). The
 * lifecycle consumer drives it exactly like the SQS / Pub/Sub / Postgres brokers; JetStream provides
 * the at-least-once delivery the port assumes.
 *
 * `receive` fetches and maps each message to `{ id, body: <parsed JSON> }`, retaining the message's
 * ack/nak controls (an unparseable body is passed through as a string so the consumer dead-letters it
 * rather than the batch throwing). `ack` acks the retained delivery; `deadLetter` publishes to
 * `deadLetterSubject` + acks the original (or, if unset, **nacks** for JetStream's native dead-letter
 * advisory). The irreversible `purge` is never a queue command (defense in depth).
 *
 * @param options - The JetStream client, source subject, and optional DLQ / batch settings.
 * @returns A NATS JetStream-backed message queue.
 */
export function createNatsMessageQueue(options: NatsMessageQueueOptions): NatsMessageQueue {
  const { client } = options;
  const maxMessages = options.maxMessages ?? 10;
  // Retain id → message so ack()/deadLetter() can drive the right delivery's controls.
  const inflight = new Map<string, NatsPulledMessage>();

  return {
    async receive(max: number): Promise<QueueMessage[]> {
      const limit = Math.min(Math.max(1, max), maxMessages);
      const pulled = await client.fetch({ batch: limit });
      const out: QueueMessage[] = [];
      for (const message of pulled) {
        inflight.set(message.id, message);
        let body: unknown = message.data;
        try {
          body = JSON.parse(message.data); // malformed JSON → pass through → consumer dead-letters
        } catch {
          body = message.data;
        }
        out.push({ id: message.id, body });
      }
      return out;
    },

    async ack(messageId: string): Promise<void> {
      const message = inflight.get(messageId);
      if (message !== undefined) {
        await message.ack();
        inflight.delete(messageId);
      }
    },

    async deadLetter(messageId: string, _reason: string): Promise<void> {
      const message = inflight.get(messageId);
      if (message === undefined) return; // unknown delivery — nothing to control
      if (options.deadLetterSubject !== undefined) {
        await client.publish({ subject: options.deadLetterSubject, data: message.data });
        await message.ack();
      } else {
        await message.nak(); // redeliver → JetStream's MaxDeliver + dead-letter advisory
      }
      inflight.delete(messageId);
    },

    async enqueue(body: unknown): Promise<void> {
      if (options.subject === undefined) {
        throw new Error('NatsMessageQueue.enqueue: a source subject is required');
      }
      await client.publish({ subject: options.subject, data: JSON.stringify(body) });
    },
  };
}
