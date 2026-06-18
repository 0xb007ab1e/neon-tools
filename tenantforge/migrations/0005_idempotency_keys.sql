-- HTTP idempotency keys: lets a client safely retry a mutating request and replay the original
-- response instead of re-executing it (topic-api-design / topic-reliability). The shared-store
-- realization so a retry that lands on a different replica still de-duplicates. Metadata only — the
-- stored body is a control-plane API response (no tenant content; connection secrets are never in
-- list/lifecycle responses). Expired rows (older than the store TTL) should be swept periodically.
CREATE TABLE IF NOT EXISTS tf_idempotency_keys (
  key          text PRIMARY KEY,   -- principal-namespaced idempotency key
  fingerprint  text NOT NULL,      -- hash of method + path + body (detects key reuse)
  created_ms   bigint NOT NULL,    -- epoch-ms the key was first reserved (for TTL expiry)
  status       int,                -- stored response status (NULL while in-flight)
  body         text,               -- stored response body (NULL while in-flight)
  content_type text                -- stored response Content-Type (NULL while in-flight)
);

-- Sweep support: find/expire old keys efficiently.
CREATE INDEX IF NOT EXISTS tf_idempotency_keys_created_ms_idx ON tf_idempotency_keys (created_ms);
