-- Per-tenant connection secrets, encrypted at rest (AES-256-GCM; key from TENANTFORGE_SECRET_KEY,
-- which is separate from this DB's credential — separation of duties, master §5). The control plane
-- only ever stores the SEALED value here; it is unreadable without the key.
CREATE TABLE IF NOT EXISTS tf_connection_secrets (
  key        text PRIMARY KEY, -- the tenant id
  sealed     text NOT NULL,    -- b64(nonce).b64(tag).b64(ciphertext)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
