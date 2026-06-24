-- One-time email-verification codes for the public self-serve signup. Stores only the code **hash**
-- (the raw code is emailed once, never persisted — master §5). One active row per email: re-issuing a
-- code upserts (resetting attempts). `attempts` bounds brute-force; `verified_at` marks single-use.
CREATE TABLE IF NOT EXISTS tf_email_verifications (
  email       text PRIMARY KEY,                  -- the address being proven (PII; never logged)
  code_hash   text NOT NULL,                     -- SHA-256 (hex) of the one-time code
  expires_at  timestamptz NOT NULL,              -- short-lived (e.g. 15 minutes)
  attempts    integer NOT NULL DEFAULT 0,        -- failed entries; at the cap the row is "locked"
  verified_at timestamptz,                       -- set once verified (single-use); NULL = pending
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Sweep expired, unverified codes (a periodic cleanup job filters on this).
CREATE INDEX IF NOT EXISTS tf_email_verifications_expires_idx
  ON tf_email_verifications (expires_at);
