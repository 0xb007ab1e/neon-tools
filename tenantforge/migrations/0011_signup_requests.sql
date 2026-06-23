-- Self-serve signup funnel. One row per public web signup, from email entry to provisioned tenant.
-- Holds **no secrets** — only references (master §5): the PSP customer/setup-intent ids, the chosen
-- tenant config, and the provisioned tenant id. The connection URI lives in the encrypted SecretStore
-- (keyed by tenant id); `connection_revealed_at` enforces a one-time in-app reveal on the success page.
DO $$ BEGIN
  CREATE TYPE tf_signup_request_status AS ENUM (
    'started', 'email_verified', 'payment_ready', 'provisioning', 'active', 'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS tf_signup_requests (
  id                     text PRIMARY KEY,                          -- opaque signup-session id
  email                  text NOT NULL,                             -- signup email (PII; never logged)
  status                 tf_signup_request_status NOT NULL DEFAULT 'started',
  customer_ref           text,                                      -- PSP customer (e.g. cus_…)
  setup_intent_id        text,                                      -- PSP setup intent
  slug                   text,                                      -- chosen tenant slug
  region                 text,                                      -- chosen region (residency)
  plan_id                text,                                      -- chosen plan
  tenant_id              uuid REFERENCES tf_tenants(id) ON DELETE SET NULL,  -- provisioned tenant
  connection_revealed_at timestamptz,                               -- one-time reveal guard
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Operator funnel view, newest-first.
CREATE INDEX IF NOT EXISTS tf_signup_requests_created_idx ON tf_signup_requests (created_at DESC);
-- Resolve a request by its chosen slug (status poll / dedupe).
CREATE INDEX IF NOT EXISTS tf_signup_requests_slug_idx ON tf_signup_requests (slug);
