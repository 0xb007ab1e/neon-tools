-- Reverse of 0001_init.sql. Drops the control-plane registry (metadata only).
DROP TABLE IF EXISTS tf_tenant_migrations;
DROP TABLE IF EXISTS tf_migrations;
DROP TABLE IF EXISTS tf_tenants;
DROP TYPE IF EXISTS tf_tenant_status;
