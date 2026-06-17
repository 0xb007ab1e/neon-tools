import { Pool } from 'pg';
import type { MessageQueue, QueueMessage } from '../../ports/message-queue.js';

/** A Postgres-backed {@link MessageQueue}, plus a producer `enqueue` and `close`. */
export interface PgMessageQueue extends MessageQueue {
  /** Enqueue a command payload; returns the new message id. */
  enqueue(body: unknown): Promise<string>;
  /** Release the connection pool. */
  close(): Promise<void>;
}

/** Options for {@link createPgMessageQueue}. */
export interface PgMessageQueueOptions {
  /** Control-plane Postgres connection string (the `tf_lifecycle_queue` table lives here). */
  connectionString: string;
  /**
   * Visibility timeout (ms): how long a received message is hidden before redelivery if not acked
   * (covers a worker crash mid-process). Defaults to 60000.
   */
  visibilityTimeoutMs?: number;
  /** Max pool size. */
  maxConnections?: number;
}

/**
 * Create a durable {@link MessageQueue} backed by Neon Postgres (`tf_lifecycle_queue`, migration
 * 0003) — the Neon-native broker. `receive` atomically claims pending, visible rows with
 * `FOR UPDATE SKIP LOCKED` and sets a visibility timeout, so multiple workers consume without
 * double-processing and a crashed worker's messages reappear. `ack` deletes; `deadLetter` keeps the
 * row with `status='dead'` for inspection.
 *
 * A different broker (SQS / NATS / Pub/Sub) can implement the same port in its own branch.
 *
 * @param options - Connection string and optional visibility timeout / pool size.
 * @returns A Postgres-backed message queue.
 */
export function createPgMessageQueue(options: PgMessageQueueOptions): PgMessageQueue {
  const visibilityTimeoutMs = options.visibilityTimeoutMs ?? 60_000;
  const pool = new Pool({
    connectionString: options.connectionString,
    ...(options.maxConnections === undefined ? {} : { max: options.maxConnections }),
  });

  return {
    async enqueue(body: unknown): Promise<string> {
      const { rows } = await pool.query<{ id: string }>(
        'INSERT INTO tf_lifecycle_queue (body) VALUES ($1::jsonb) RETURNING id',
        [JSON.stringify(body)],
      );
      return String(rows[0]!.id);
    },

    async receive(max: number): Promise<QueueMessage[]> {
      // Atomically claim pending+visible rows and hide them for the visibility window.
      const { rows } = await pool.query<{ id: string; body: unknown }>(
        `UPDATE tf_lifecycle_queue
           SET visible_at = now() + ($2 || ' milliseconds')::interval
         WHERE id IN (
           SELECT id FROM tf_lifecycle_queue
           WHERE status = 'pending' AND visible_at <= now()
           ORDER BY id
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING id, body`,
        [max, visibilityTimeoutMs],
      );
      return rows.map((r) => ({ id: String(r.id), body: r.body }));
    },

    async ack(messageId: string): Promise<void> {
      await pool.query('DELETE FROM tf_lifecycle_queue WHERE id = $1', [messageId]);
    },

    async deadLetter(messageId: string, reason: string): Promise<void> {
      await pool.query(
        `UPDATE tf_lifecycle_queue SET status = 'dead', reason = $2, visible_at = now()
         WHERE id = $1`,
        [messageId, reason],
      );
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
