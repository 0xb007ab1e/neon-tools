-- One-time tenant signup / invite tokens. The operator issues a scoped, expiring token; redeeming
-- it provisions the tenant (the "signup" lifecycle stage Neon leaves to the builder). Only the
-- token's SHA-256 **hash** is stored — the raw token is shown once at issue and never persisted
-- (treat it like a credential; master §5). Metadata only — no secrets/PII.
CREATE TABLE IF NOT EXISTS tf_signup_tokens (
  token_hash         text PRIMARY KEY,          -- sha256(raw token) hex; raw token never stored
  slug               text NOT NULL,             -- desired tenant slug (provisioned on redeem)
  region             text,                       -- optional region override
  plan_id            text,                       -- optional plan to record on the tenant
  expires_at         timestamptz NOT NULL,
  redeemed_at        timestamptz,                -- set when consumed (single-use)
  redeemed_tenant_id text,                        -- the tenant provisioned on redemption
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Listing, newest-first.
CREATE INDEX IF NOT EXISTS tf_signup_tokens_created_idx ON tf_signup_tokens (created_at DESC);
