-- Durable state for the mandatory erasure undo window (threat-model B8w / red-team F2). One row per
-- scheduled tenant erasure, from `pending` (cancellable) through the atomic `processing` claim to a
-- terminal `done`/`cancelled`. Holds **no secrets** and minimal PII (master §5): `tenant_email` (the
-- billing email captured at request time, so the executor can send a completion notice after the
-- tenant record is erased) and `reason` (audit) are NULLABLE and **cleared on the terminal
-- transition** (review L3 — data minimization). The single-winner cancel/claim flips are atomic SQL
-- conditional UPDATEs (`… WHERE status='pending'` + rowcount), so the invariant holds **across
-- replicas**, not just within one process — the prerequisite for flipping the portal's destructive
-- self-serve flag on in multi-replica / restart-sensitive production.
DO $$ BEGIN
  CREATE TYPE tf_pending_erasure_status AS ENUM ('pending', 'processing', 'cancelled', 'done');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS tf_pending_erasures (
  id            text PRIMARY KEY,                                  -- opaque request id
  tenant_id     uuid NOT NULL REFERENCES tf_tenants(id) ON DELETE CASCADE, -- the tenant to erase
  status        tf_pending_erasure_status NOT NULL DEFAULT 'pending',
  tenant_email  text,                                             -- PII; captured at request time; cleared on terminal
  reason        text,                                             -- audit reason; cleared on terminal
  requested_at  timestamptz NOT NULL,                             -- when the request was made
  execute_at    timestamptz NOT NULL,                             -- request time + undo window
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One in-flight (active) request per tenant: at most one row per tenant in a non-terminal state.
-- A partial unique index lets a new request be created after the prior one reaches a terminal state.
CREATE UNIQUE INDEX IF NOT EXISTS tf_pending_erasures_active_tenant_idx
  ON tf_pending_erasures (tenant_id)
  WHERE status IN ('pending', 'processing');

-- The executor's due-scan: pending rows whose window has elapsed, ordered by execute_at.
CREATE INDEX IF NOT EXISTS tf_pending_erasures_due_idx
  ON tf_pending_erasures (status, execute_at);
