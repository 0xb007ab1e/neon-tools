-- Per-tenant credit ledger: an append-only log of credit entries. A positive `amount_minor` is a
-- grant (credit added — e.g. a plan-downgrade proration, goodwill, or a refund-as-credit); a
-- negative one is a consumption (credit applied against a charge). The balance is SUM(amount_minor)
-- per (tenant, currency), never below zero. Authoritative (not the best-effort audit trail) because
-- it gates money. Metadata only — no secrets/PII (master §5).
CREATE TABLE IF NOT EXISTS tf_credits (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    text NOT NULL,
  amount_minor bigint NOT NULL,            -- signed: > 0 grant, < 0 consumption (minor units)
  currency     text NOT NULL,             -- lowercase ISO 4217
  reason       text NOT NULL,
  reference    text,                       -- idempotency anchor (e.g. the billing period for a consumption)
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Balance scans by (tenant, currency).
CREATE INDEX IF NOT EXISTS tf_credits_tenant_currency_idx ON tf_credits (tenant_id, currency);
-- History scans, newest-first.
CREATE INDEX IF NOT EXISTS tf_credits_tenant_at_idx ON tf_credits (tenant_id, created_at DESC);
-- Idempotent consumption: at most one consumption row per (tenant, currency, reference), so a
-- re-charge for the same period never double-consumes credit. Partial — grants aren't deduped.
CREATE UNIQUE INDEX IF NOT EXISTS tf_credits_consume_ref_idx
  ON tf_credits (tenant_id, currency, reference)
  WHERE amount_minor < 0 AND reference IS NOT NULL;
