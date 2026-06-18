import { describe, expect, it } from 'vitest';
import {
  createSqsMessageQueue,
  type SqsClientLike,
  type SqsMessage,
  type SqsReceiveInput,
  type SqsSendInput,
} from '../../src/adapters/sqs/message-queue.js';

interface Calls {
  receive: SqsReceiveInput[];
  deletes: { QueueUrl: string; ReceiptHandle: string }[];
  sends: SqsSendInput[];
}

/** A fake SQS client that serves queued receive batches and records mutations. */
function fakeClient(batches: SqsMessage[][] = []): { client: SqsClientLike; calls: Calls } {
  const calls: Calls = { receive: [], deletes: [], sends: [] };
  const queue = [...batches];
  const client: SqsClientLike = {
    receiveMessages(input) {
      calls.receive.push(input);
      const batch = queue.shift();
      return Promise.resolve(batch === undefined ? {} : { Messages: batch });
    },
    deleteMessage(input) {
      calls.deletes.push(input);
      return Promise.resolve({});
    },
    sendMessage(input) {
      calls.sends.push(input);
      return Promise.resolve({ MessageId: 'm-new' });
    },
  };
  return { client, calls };
}

describe('createSqsMessageQueue — receive', () => {
  it('long-polls and maps messages to { id: ReceiptHandle, body: parsed }', async () => {
    const { client, calls } = fakeClient([
      [
        {
          MessageId: 'm1',
          ReceiptHandle: 'rh1',
          Body: JSON.stringify({ id: 'c1', type: 'suspend' }),
        },
      ],
    ]);
    const q = createSqsMessageQueue({ client, queueUrl: 'https://sqs/main' });
    const msgs = await q.receive(5);

    expect(msgs).toEqual([{ id: 'rh1', body: { id: 'c1', type: 'suspend' } }]);
    expect(calls.receive[0]).toEqual({
      QueueUrl: 'https://sqs/main',
      MaxNumberOfMessages: 5,
      WaitTimeSeconds: 20,
      VisibilityTimeout: 60,
    });
  });

  it('returns an empty array when the queue is drained', async () => {
    const { client } = fakeClient([]); // no batch → Messages undefined
    const q = createSqsMessageQueue({ client, queueUrl: 'https://sqs/main' });
    expect(await q.receive(10)).toEqual([]);
  });

  it('clamps the batch size to 1..maxMessages (SQS caps at 10)', async () => {
    const { client, calls } = fakeClient([[], []]);
    const q = createSqsMessageQueue({ client, queueUrl: 'u', maxMessages: 10 });
    await q.receive(50);
    await q.receive(0);
    expect(calls.receive[0]!.MaxNumberOfMessages).toBe(10);
    expect(calls.receive[1]!.MaxNumberOfMessages).toBe(1);
  });

  it('skips messages with no ReceiptHandle and passes malformed JSON through as a string', async () => {
    const { client } = fakeClient([
      [
        { MessageId: 'm1', Body: 'no-handle' }, // skipped
        { ReceiptHandle: 'rh2', Body: 'not json{' }, // body stays a string
        { ReceiptHandle: 'rh3' }, // missing Body → empty string
      ],
    ]);
    const q = createSqsMessageQueue({ client, queueUrl: 'u' });
    const msgs = await q.receive(10);
    expect(msgs).toEqual([
      { id: 'rh2', body: 'not json{' },
      { id: 'rh3', body: '' },
    ]);
  });
});

describe('createSqsMessageQueue — ack', () => {
  it('deletes the message by receipt handle', async () => {
    const { client, calls } = fakeClient([[{ ReceiptHandle: 'rh1', Body: '{}' }]]);
    const q = createSqsMessageQueue({ client, queueUrl: 'https://sqs/main' });
    await q.receive(10);
    await q.ack('rh1');
    expect(calls.deletes).toEqual([{ QueueUrl: 'https://sqs/main', ReceiptHandle: 'rh1' }]);
  });
});

describe('createSqsMessageQueue — deadLetter', () => {
  it('moves the message to the app DLQ (send + delete) with the reason attribute', async () => {
    const { client, calls } = fakeClient([[{ ReceiptHandle: 'rh1', Body: '{"bad":true}' }]]);
    const q = createSqsMessageQueue({
      client,
      queueUrl: 'https://sqs/main',
      dlqUrl: 'https://sqs/dlq',
    });
    await q.receive(10);
    await q.deadLetter('rh1', 'invalid payload');

    expect(calls.sends).toEqual([
      {
        QueueUrl: 'https://sqs/dlq',
        MessageBody: '{"bad":true}',
        MessageAttributes: {
          DeadLetterReason: { DataType: 'String', StringValue: 'invalid payload' },
        },
      },
    ]);
    expect(calls.deletes).toEqual([{ QueueUrl: 'https://sqs/main', ReceiptHandle: 'rh1' }]);
  });

  it('leaves the message for SQS native redrive when no app DLQ is configured', async () => {
    const { client, calls } = fakeClient([[{ ReceiptHandle: 'rh1', Body: '{}' }]]);
    const q = createSqsMessageQueue({ client, queueUrl: 'https://sqs/main' });
    await q.receive(10);
    await q.deadLetter('rh1', 'handler failed');
    expect(calls.sends).toEqual([]);
    expect(calls.deletes).toEqual([]); // not deleted → SQS redrives after maxReceiveCount
  });

  it('leaves the message when the body is unknown (e.g. handle not from this instance)', async () => {
    const { client, calls } = fakeClient([]);
    const q = createSqsMessageQueue({ client, queueUrl: 'u', dlqUrl: 'https://sqs/dlq' });
    await q.deadLetter('rh-unknown', 'reason');
    expect(calls.sends).toEqual([]);
    expect(calls.deletes).toEqual([]);
  });
});

describe('createSqsMessageQueue — enqueue', () => {
  it('JSON-encodes the body and returns the message id', async () => {
    const { client, calls } = fakeClient();
    const q = createSqsMessageQueue({ client, queueUrl: 'https://sqs/main' });
    const id = await q.enqueue({ id: 'c1', type: 'provision', slug: 'acme' });
    expect(id).toBe('m-new');
    expect(calls.sends[0]).toEqual({
      QueueUrl: 'https://sqs/main',
      MessageBody: JSON.stringify({ id: 'c1', type: 'provision', slug: 'acme' }),
    });
  });

  it('returns an empty id when SQS omits MessageId', async () => {
    const client: SqsClientLike = {
      receiveMessages: () => Promise.resolve({}),
      deleteMessage: () => Promise.resolve({}),
      sendMessage: () => Promise.resolve({}), // no MessageId
    };
    const q = createSqsMessageQueue({ client, queueUrl: 'u' });
    expect(await q.enqueue({ id: 'c1', type: 'resume', tenantId: 't1' })).toBe('');
  });
});
