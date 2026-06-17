-- TenantForge control-plane registry — initial schema.
-- Holds tenant METADATA only (provision/route/orchestrate). Never tenant content (ARCHITECTURE §4).

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- Tenant lifecycle status (mirrors the core lifecycle state machine).
DO $$ BEGIN
  CREATE TYPE tf_tenant_status AS ENUM (
    'provisioning', 'active', 'suspended', 'offboarding', 'deleted'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- The tenant registry.
CREATE TABLE IF NOT EXISTS tf_tenants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE,
  region          text NOT NULL,
  status          tf_tenant_status NOT NULL DEFAULT 'provisioning',
  neon_project_id text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tf_tenants_status_idx ON tf_tenants (status);

-- The fleet-migration catalog.
CREATE TABLE IF NOT EXISTS tf_migrations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version    text NOT NULL UNIQUE,
  checksum   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Per-tenant fleet-migration state — resumable, per-tenant success/failure (ARCHITECTURE §4).
CREATE TABLE IF NOT EXISTS tf_tenant_migrations (
  tenant_id    uuid NOT NULL REFERENCES tf_tenants (id) ON DELETE CASCADE,
  migration_id uuid NOT NULL REFERENCES tf_migrations (id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'pending',
  error        text,
  applied_at   timestamptz,
  PRIMARY KEY (tenant_id, migration_id)
);
