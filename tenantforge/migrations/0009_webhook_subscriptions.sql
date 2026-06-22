-- Managed outbound webhook subscriptions. Each row is an endpoint that receives matching
-- control-plane events, HMAC-signed with its own secret. The signing **secret is NOT stored here**
-- — it lives in the encrypted SecretStore (keyed `webhook-sub:<id>`), so this table holds metadata
-- only (master §5: secrets encrypted at rest under a separate key). Empty event_types = all events.
CREATE TABLE IF NOT EXISTS tf_webhook_subscriptions (
  id          text PRIMARY KEY,                  -- opaque id; also the SecretStore key suffix
  url         text NOT NULL,                     -- https endpoint (SSRF-validated at create time)
  event_types text[] NOT NULL DEFAULT '{}',      -- event-name allow-list; empty = every event
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Listing, newest-first.
CREATE INDEX IF NOT EXISTS tf_webhook_subscriptions_created_idx
  ON tf_webhook_subscriptions (created_at DESC);
