import type { MessageQueue, QueueMessage } from '../../ports/message-queue.js';

// --- A minimal SQS client surface (the fields this adapter uses) -------------------------------
// Zero-dependency by design: the AWS SDK v3 `SQSClient` satisfies this via a tiny shim, so we don't
// pull the SDK tree into the project. Wire it at the composition root, e.g.:
//   const sqs = new SQSClient({ region });
//   const client: SqsClientLike = {
//     receiveMessages: (i) => sqs.send(new ReceiveMessageCommand(i)),
//     deleteMessage: (i) => sqs.send(new DeleteMessageCommand(i)),
//     sendMessage: (i) => sqs.send(new SendMessageCommand(i)),
//   };

/** A single SQS message (subset of the SDK's `Message`). */
export interface SqsMessage {
  /** SQS message id. */
  MessageId?: string;
  /** Handle used to delete/return the message — this is our {@link QueueMessage.id}. */
  ReceiptHandle?: string;
  /** The message body (a JSON-encoded command). */
  Body?: string;
}

/** `ReceiveMessage` input (subset). */
export interface SqsReceiveInput {
  QueueUrl: string;
  MaxNumberOfMessages?: number;
  WaitTimeSeconds?: number;
  VisibilityTimeout?: number;
}

/** `SendMessage` input (subset). */
export interface SqsSendInput {
  QueueUrl: string;
  MessageBody: string;
  MessageAttributes?: Record<string, { DataType: string; StringValue: string }>;
}

/** The narrow SQS client this adapter depends on (the AWS SDK `SQSClient` satisfies it via a shim). */
export interface SqsClientLike {
  receiveMessages(input: SqsReceiveInput): Promise<{ Messages?: SqsMessage[] }>;
  deleteMessage(input: { QueueUrl: string; ReceiptHandle: string }): Promise<unknown>;
  sendMessage(input: SqsSendInput): Promise<{ MessageId?: string }>;
}

/** An SQS-backed {@link MessageQueue}, plus a producer `enqueue`. */
export interface SqsMessageQueue extends MessageQueue {
  /** Enqueue a command payload (JSON-encoded); returns the SQS message id. */
  enqueue(body: unknown): Promise<string>;
}

/** Options for {@link createSqsMessageQueue}. */
export interface SqsMessageQueueOptions {
  /** The narrow SQS client (wrap your `@aws-sdk/client-sqs` `SQSClient`). */
  client: SqsClientLike;
  /** Source queue URL. */
  queueUrl: string;
  /**
   * App-level dead-letter queue URL. When set, {@link MessageQueue.deadLetter} moves the message
   * here immediately. When unset, dead-lettering leaves the message for SQS's **native redrive
   * policy** (configure `maxReceiveCount` + a DLQ ARN on the source queue).
   */
  dlqUrl?: string;
  /** Max messages per receive (SQS caps at 10). Defaults to 10. */
  maxMessages?: number;
  /** Long-poll wait (seconds). Defaults to 20. */
  waitTimeSeconds?: number;
  /** Visibility timeout (seconds) for received messages. Defaults to 60. */
  visibilityTimeoutSeconds?: number;
}

/**
 * Create a {@link MessageQueue} backed by **AWS SQS**, over a minimal injected client (so the AWS
 * SDK is not a dependency of this project — wrap your `SQSClient` per the shim above). The lifecycle
 * consumer drives it exactly like the Postgres broker; SQS provides the at-least-once delivery the
 * port assumes.
 *
 * `receive` long-polls and maps each SQS message to `{ id: ReceiptHandle, body: <parsed JSON> }`
 * (an unparseable body is passed through as a string so the consumer dead-letters it rather than the
 * batch throwing). `ack` deletes the message; `deadLetter` moves it to `dlqUrl` (or, if unset, leaves
 * it for SQS's redrive policy). The irreversible `purge` is never a queue command (defense in depth).
 *
 * @param options - The SQS client, queue URL, and optional DLQ / batch / timeout settings.
 * @returns An SQS-backed message queue.
 */
export function createSqsMessageQueue(options: SqsMessageQueueOptions): SqsMessageQueue {
  const { client, queueUrl } = options;
  const maxMessages = Math.min(options.maxMessages ?? 10, 10);
  const waitTimeSeconds = options.waitTimeSeconds ?? 20;
  const visibilityTimeoutSeconds = options.visibilityTimeoutSeconds ?? 60;
  // Track receipt-handle → raw body so deadLetter() can re-send the payload to the app DLQ.
  const bodies = new Map<string, string>();

  return {
    async receive(max: number): Promise<QueueMessage[]> {
      const limit = Math.min(Math.max(1, max), maxMessages);
      const { Messages } = await client.receiveMessages({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: limit,
        WaitTimeSeconds: waitTimeSeconds,
        VisibilityTimeout: visibilityTimeoutSeconds,
      });
      const out: QueueMessage[] = [];
      for (const message of Messages ?? []) {
        if (message.ReceiptHandle === undefined) continue; // can't ack it — skip
        const raw = message.Body ?? '';
        bodies.set(message.ReceiptHandle, raw);
        let body: unknown = raw;
        try {
          body = JSON.parse(raw); // pass malformed JSON through as a string → consumer dead-letters
        } catch {
          body = raw;
        }
        out.push({ id: message.ReceiptHandle, body });
      }
      return out;
    },

    async ack(messageId: string): Promise<void> {
      await client.deleteMessage({ QueueUrl: queueUrl, ReceiptHandle: messageId });
      bodies.delete(messageId);
    },

    async deadLetter(messageId: string, reason: string): Promise<void> {
      const body = bodies.get(messageId);
      if (options.dlqUrl !== undefined && body !== undefined) {
        await client.sendMessage({
          QueueUrl: options.dlqUrl,
          MessageBody: body,
          MessageAttributes: {
            DeadLetterReason: { DataType: 'String', StringValue: reason.slice(0, 256) },
          },
        });
        await client.deleteMessage({ QueueUrl: queueUrl, ReceiptHandle: messageId });
      }
      // else: no app DLQ (or unknown body) → leave it for SQS's native redrive policy.
      bodies.delete(messageId);
    },

    async enqueue(body: unknown): Promise<string> {
      const { MessageId } = await client.sendMessage({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(body),
      });
      return MessageId ?? '';
    },
  };
}
