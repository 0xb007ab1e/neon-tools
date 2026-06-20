-- Persisted control-plane audit trail: an append-only record of (already-redacted) tenant events
-- (who-did-what-when — NIST AU, SOC2 change management, OWASP A09). The EventSink stream is
-- ephemeral (stdout); this table keeps a queryable record so the compliance report can attest
-- erasure history + a recent audit excerpt. Metadata only — context is redacted before emission
-- (no connection secrets / PII; master §5). Retention is governed by data-lifecycle policy.
CREATE TABLE IF NOT EXISTS tf_audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event       text NOT NULL,             -- dotted event name, e.g. tenant.transition
  at          timestamptz NOT NULL,      -- emission instant (UTC)
  outcome     text NOT NULL,             -- 'ok' | 'error'
  actor_id    text,                      -- operator identity (NULL for scheduled sweeps)
  actor_role  text,
  tenant_id   text,                      -- tenant the event concerns (NULL for fleet-level events)
  duration_ms integer,
  context     jsonb,                     -- safe, non-sensitive context (already redacted)
  error       text                       -- failure message when outcome = 'error'
);

-- Query support: newest-first scans, and filtered-by-event / filtered-by-tenant reads.
CREATE INDEX IF NOT EXISTS tf_audit_log_at_idx ON tf_audit_log (at DESC);
CREATE INDEX IF NOT EXISTS tf_audit_log_event_at_idx ON tf_audit_log (event, at DESC);
CREATE INDEX IF NOT EXISTS tf_audit_log_tenant_at_idx ON tf_audit_log (tenant_id, at DESC);
