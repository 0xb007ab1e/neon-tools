-- Durable evidence-at-rest for signed compliance bundles (ADR-0011 Phase 3b — the durable manifest
-- index that closes the Phase 3a in-process-index gap so retrieval + prune survive restart and hold
-- across replicas; mirrors `tf_pending_erasures`, migration 0012). One row per persisted bundle.
--
-- Holds **no secrets** (master §5): the `body` jsonb is the **signed** bundle (`{ bundle, jws }`) —
-- attestation FACTS ONLY (counts, isolation/residency booleans + offending ids, a PII-minimized audit
-- excerpt, embedded already-signed erasure-cert JWS strings) and its EdDSA signature; never a
-- connection URI, never a signing key. The bundle is **confidential** (tenant ids/residency) but
-- secret-free, and lives in the metadata control-plane DB, never tenant content. Encryption at rest is
-- the underlying Postgres/volume concern (consistent with the rest of the control-plane registry).
--
-- `tenant_id` is **NOT** a FK to tf_tenants: evidence must **outlive** the tenant it attests (an
-- auditor still needs a deleted tenant's erasure/compliance evidence), so a tenant purge must never
-- cascade-delete its evidence. It is plain text (the bundle's own server-derived tenant id) so the
-- Phase 3b retrieval surface can enforce per-tenant ownership (BOLA). NULL for a fleet bundle.
CREATE TABLE IF NOT EXISTS tf_evidence_bundles (
  bundle_id       text PRIMARY KEY,                 -- non-guessable 128-bit CSPRNG id (mintEvidenceBundleId)
  scope           text NOT NULL CHECK (scope IN ('fleet', 'tenant')),
  tenant_id       text,                             -- server-derived; present iff scope='tenant'; no FK (evidence outlives tenant)
  generated_at    timestamptz NOT NULL,             -- when the bundle was generated (from the bundle)
  stored_at       timestamptz NOT NULL,             -- when persisted (the index/at-rest timestamp)
  signer_kid      text NOT NULL,                    -- the JWS `kid` the bundle was signed under (provenance, not a secret)
  content_hashes  jsonb NOT NULL,                   -- per-artifact SHA-256 (hex) spot-check hashes (facts)
  retention_until timestamptz,                      -- prune eligibility; NULL ⇒ indefinite retention
  body            jsonb NOT NULL,                   -- the signed bundle { bundle, jws } — NO secrets
  -- scope/tenant_id invariant in the DB (defense in depth, mirrors the verifier's invariant): a tenant
  -- bundle must carry a tenant_id; a fleet bundle must not.
  CONSTRAINT tf_evidence_bundles_scope_tenant_ck CHECK (
    (scope = 'tenant' AND tenant_id IS NOT NULL) OR (scope = 'fleet' AND tenant_id IS NULL)
  )
);

-- List is newest-stored-first and filterable by scope / tenant; retention sweep scans by deadline.
CREATE INDEX IF NOT EXISTS tf_evidence_bundles_stored_at_idx ON tf_evidence_bundles (stored_at DESC);
CREATE INDEX IF NOT EXISTS tf_evidence_bundles_scope_idx ON tf_evidence_bundles (scope);
CREATE INDEX IF NOT EXISTS tf_evidence_bundles_tenant_idx ON tf_evidence_bundles (tenant_id);
-- Partial index over rows with a finite retention window — the prune sweep's due-scan (NULL = indefinite).
CREATE INDEX IF NOT EXISTS tf_evidence_bundles_retention_idx
  ON tf_evidence_bundles (retention_until)
  WHERE retention_until IS NOT NULL;
