import { describe, expect, it } from 'vitest';
import {
  createPubSubMessageQueue,
  type PubSubClientLike,
  type PubSubPulledMessage,
} from '../../src/adapters/pubsub/message-queue.js';

interface Calls {
  pull: { subscription: string; maxMessages: number }[];
  acks: { subscription: string; ackIds: string[] }[];
  modAcks: { subscription: string; ackIds: string[]; seconds: number }[];
  publishes: { topic: string; data: string }[];
}

/** A fake Pub/Sub client that serves queued pull batches and records mutations. */
function fakeClient(batches: PubSubPulledMessage[][] = []): {
  client: PubSubClientLike;
  calls: Calls;
} {
  const calls: Calls = { pull: [], acks: [], modAcks: [], publishes: [] };
  const queue = [...batches];
  const client: PubSubClientLike = {
    pull(input) {
      calls.pull.push(input);
      return Promise.resolve(queue.shift() ?? []);
    },
    acknowledge(input) {
      calls.acks.push(input);
      return Promise.resolve();
    },
    modifyAckDeadline(input) {
      calls.modAcks.push(input);
      return Promise.resolve();
    },
    publish(input) {
      calls.publishes.push(input);
      return Promise.resolve('m-new');
    },
  };
  return { client, calls };
}

const sub = 'projects/p/subscriptions/s';

describe('createPubSubMessageQueue — receive', () => {
  it('pulls and maps messages to { id: ackId, body: parsed }', async () => {
    const { client, calls } = fakeClient([
      [{ ackId: 'a1', data: JSON.stringify({ id: 'c1', type: 'suspend' }) }],
    ]);
    const q = createPubSubMessageQueue({ client, subscription: sub });
    const msgs = await q.receive(5);

    expect(msgs).toEqual([{ id: 'a1', body: { id: 'c1', type: 'suspend' } }]);
    expect(calls.pull[0]).toEqual({ subscription: sub, maxMessages: 5 });
  });

  it('returns an empty array when the subscription is drained', async () => {
    const { client } = fakeClient([]);
    const q = createPubSubMessageQueue({ client, subscription: sub });
    expect(await q.receive(10)).toEqual([]);
  });

  it('clamps the batch size to 1..maxMessages', async () => {
    const { client, calls } = fakeClient([[], []]);
    const q = createPubSubMessageQueue({ client, subscription: sub, maxMessages: 10 });
    await q.receive(50);
    await q.receive(0);
    expect(calls.pull[0]!.maxMessages).toBe(10);
    expect(calls.pull[1]!.maxMessages).toBe(1);
  });

  it('passes malformed JSON through as a string', async () => {
    const { client } = fakeClient([[{ ackId: 'a2', data: 'not json{' }]]);
    const q = createPubSubMessageQueue({ client, subscription: sub });
    expect(await q.receive(10)).toEqual([{ id: 'a2', body: 'not json{' }]);
  });
});

describe('createPubSubMessageQueue — ack', () => {
  it('acknowledges the delivery by ack id', async () => {
    const { client, calls } = fakeClient([[{ ackId: 'a1', data: '{}' }]]);
    const q = createPubSubMessageQueue({ client, subscription: sub });
    await q.receive(10);
    await q.ack('a1');
    expect(calls.acks).toEqual([{ subscription: sub, ackIds: ['a1'] }]);
  });
});

describe('createPubSubMessageQueue — deadLetter', () => {
  it('publishes to the app DLQ topic and acks the original', async () => {
    const { client, calls } = fakeClient([[{ ackId: 'a1', data: '{"bad":true}' }]]);
    const q = createPubSubMessageQueue({
      client,
      subscription: sub,
      deadLetterTopic: 'projects/p/topics/dlq',
    });
    await q.receive(10);
    await q.deadLetter('a1', 'invalid payload');

    expect(calls.publishes).toEqual([{ topic: 'projects/p/topics/dlq', data: '{"bad":true}' }]);
    expect(calls.acks).toEqual([{ subscription: sub, ackIds: ['a1'] }]);
    expect(calls.modAcks).toEqual([]);
  });

  it('nacks (ack-deadline 0) for native DLQ when no app DLQ topic is configured', async () => {
    const { client, calls } = fakeClient([[{ ackId: 'a1', data: '{}' }]]);
    const q = createPubSubMessageQueue({ client, subscription: sub });
    await q.receive(10);
    await q.deadLetter('a1', 'handler failed');
    expect(calls.publishes).toEqual([]);
    expect(calls.modAcks).toEqual([{ subscription: sub, ackIds: ['a1'], seconds: 0 }]);
  });

  it('nacks when the body is unknown even if a DLQ topic is set', async () => {
    const { client, calls } = fakeClient();
    const q = createPubSubMessageQueue({
      client,
      subscription: sub,
      deadLetterTopic: 'projects/p/topics/dlq',
    });
    await q.deadLetter('a-unknown', 'reason');
    expect(calls.publishes).toEqual([]);
    expect(calls.modAcks).toEqual([{ subscription: sub, ackIds: ['a-unknown'], seconds: 0 }]);
  });
});

describe('createPubSubMessageQueue — enqueue', () => {
  it('JSON-encodes the body, publishes to the source topic, and returns the message id', async () => {
    const { client, calls } = fakeClient();
    const q = createPubSubMessageQueue({
      client,
      subscription: sub,
      topic: 'projects/p/topics/main',
    });
    const id = await q.enqueue({ id: 'c1', type: 'provision', slug: 'acme' });
    expect(id).toBe('m-new');
    expect(calls.publishes).toEqual([
      {
        topic: 'projects/p/topics/main',
        data: JSON.stringify({ id: 'c1', type: 'provision', slug: 'acme' }),
      },
    ]);
  });

  it('throws when no source topic is configured', async () => {
    const { client } = fakeClient();
    const q = createPubSubMessageQueue({ client, subscription: sub });
    await expect(q.enqueue({ id: 'c1' })).rejects.toThrow(/a source topic is required/);
  });
});
