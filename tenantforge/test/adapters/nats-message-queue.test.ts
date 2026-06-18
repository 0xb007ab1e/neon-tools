import { describe, expect, it, vi } from 'vitest';
import {
  createNatsMessageQueue,
  type NatsClientLike,
  type NatsPulledMessage,
} from '../../src/adapters/nats/message-queue.js';

interface Calls {
  fetch: { batch: number }[];
  publishes: { subject: string; data: string }[];
}

/** Build a pulled message with spy ack/nak controls. */
function msg(
  id: string,
  data: string,
): NatsPulledMessage & { ackSpy: () => void; nakSpy: () => void } {
  const ackSpy = vi.fn();
  const nakSpy = vi.fn();
  return {
    id,
    data,
    ack: () => {
      ackSpy();
      return Promise.resolve();
    },
    nak: () => {
      nakSpy();
      return Promise.resolve();
    },
    ackSpy,
    nakSpy,
  };
}

/** A fake JetStream client that serves queued fetch batches and records publishes. */
function fakeClient(batches: NatsPulledMessage[][] = []): { client: NatsClientLike; calls: Calls } {
  const calls: Calls = { fetch: [], publishes: [] };
  const queue = [...batches];
  const client: NatsClientLike = {
    fetch(input) {
      calls.fetch.push(input);
      return Promise.resolve(queue.shift() ?? []);
    },
    publish(input) {
      calls.publishes.push(input);
      return Promise.resolve();
    },
  };
  return { client, calls };
}

describe('createNatsMessageQueue — receive', () => {
  it('fetches and maps messages to { id, body: parsed }', async () => {
    const { client, calls } = fakeClient([
      [msg('1', JSON.stringify({ id: 'c1', type: 'suspend' }))],
    ]);
    const q = createNatsMessageQueue({ client });
    const msgs = await q.receive(5);

    expect(msgs).toEqual([{ id: '1', body: { id: 'c1', type: 'suspend' } }]);
    expect(calls.fetch[0]).toEqual({ batch: 5 });
  });

  it('returns an empty array when the consumer is drained', async () => {
    const { client } = fakeClient([]);
    const q = createNatsMessageQueue({ client });
    expect(await q.receive(10)).toEqual([]);
  });

  it('clamps the batch size to 1..maxMessages', async () => {
    const { client, calls } = fakeClient([[], []]);
    const q = createNatsMessageQueue({ client, maxMessages: 10 });
    await q.receive(50);
    await q.receive(0);
    expect(calls.fetch[0]!.batch).toBe(10);
    expect(calls.fetch[1]!.batch).toBe(1);
  });

  it('passes malformed JSON through as a string', async () => {
    const { client } = fakeClient([[msg('2', 'not json{')]]);
    const q = createNatsMessageQueue({ client });
    expect(await q.receive(10)).toEqual([{ id: '2', body: 'not json{' }]);
  });
});

describe('createNatsMessageQueue — ack', () => {
  it('acks the retained delivery', async () => {
    const m = msg('1', '{}');
    const { client } = fakeClient([[m]]);
    const q = createNatsMessageQueue({ client });
    await q.receive(10);
    await q.ack('1');
    expect(m.ackSpy).toHaveBeenCalledOnce();
  });

  it('is a no-op for an unknown delivery id', async () => {
    const { client } = fakeClient();
    const q = createNatsMessageQueue({ client });
    await expect(q.ack('nope')).resolves.toBeUndefined();
  });
});

describe('createNatsMessageQueue — deadLetter', () => {
  it('publishes to the app DLQ subject and acks the original', async () => {
    const m = msg('1', '{"bad":true}');
    const { client, calls } = fakeClient([[m]]);
    const q = createNatsMessageQueue({ client, deadLetterSubject: 'dlq.lifecycle' });
    await q.receive(10);
    await q.deadLetter('1', 'invalid payload');

    expect(calls.publishes).toEqual([{ subject: 'dlq.lifecycle', data: '{"bad":true}' }]);
    expect(m.ackSpy).toHaveBeenCalledOnce();
    expect(m.nakSpy).not.toHaveBeenCalled();
  });

  it('nacks for native dead-lettering when no DLQ subject is configured', async () => {
    const m = msg('1', '{}');
    const { client, calls } = fakeClient([[m]]);
    const q = createNatsMessageQueue({ client });
    await q.receive(10);
    await q.deadLetter('1', 'handler failed');
    expect(calls.publishes).toEqual([]);
    expect(m.nakSpy).toHaveBeenCalledOnce();
  });

  it('is a no-op for an unknown delivery id', async () => {
    const { client, calls } = fakeClient();
    const q = createNatsMessageQueue({ client, deadLetterSubject: 'dlq.lifecycle' });
    await q.deadLetter('nope', 'reason');
    expect(calls.publishes).toEqual([]);
  });
});

describe('createNatsMessageQueue — enqueue', () => {
  it('JSON-encodes the body and publishes to the source subject', async () => {
    const { client, calls } = fakeClient();
    const q = createNatsMessageQueue({ client, subject: 'lifecycle.commands' });
    await q.enqueue({ id: 'c1', type: 'provision', slug: 'acme' });
    expect(calls.publishes).toEqual([
      {
        subject: 'lifecycle.commands',
        data: JSON.stringify({ id: 'c1', type: 'provision', slug: 'acme' }),
      },
    ]);
  });

  it('throws when no source subject is configured', async () => {
    const { client } = fakeClient();
    const q = createNatsMessageQueue({ client });
    await expect(q.enqueue({ id: 'c1' })).rejects.toThrow(/a source subject is required/);
  });
});
