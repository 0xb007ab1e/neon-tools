-- Postgres-backed lifecycle command queue (the Neon-native MessageQueue adapter). Polled with
-- FOR UPDATE SKIP LOCKED + a visibility timeout so multiple workers can consume safely; failed
-- messages are kept with status='dead' for inspection (the dead-letter queue).
CREATE TABLE IF NOT EXISTS tf_lifecycle_queue (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  body       jsonb NOT NULL,                  -- the untrusted command payload (validated on consume)
  status     text NOT NULL DEFAULT 'pending', -- pending | dead
  visible_at timestamptz NOT NULL DEFAULT now(), -- not eligible until now() >= visible_at
  reason     text,                            -- dead-letter reason
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Supports the claim query (pending + visible, ordered by id).
CREATE INDEX IF NOT EXISTS tf_lifecycle_queue_poll_idx
  ON tf_lifecycle_queue (status, visible_at, id);
