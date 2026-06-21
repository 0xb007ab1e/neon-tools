import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import type {
  FleetMigration,
  JsonObject,
  MigrationStatus,
  TenantMigrationState,
  TenantRecord,
  TenantStatus,
} from '../../core/domain.js';
import type { NewTenant, TenantRegistry } from '../../ports/tenant-registry.js';
import { assertPostgresTls } from '../../core/transport-security.js';

/** A raw `tf_tenants` row as returned by pg. */
interface TenantRow {
  id: string;
  slug: string;
  region: string;
  status: TenantStatus;
  neon_project_id: string | null;
  metadata: JsonObject;
  created_at: Date;
  updated_at: Date;
}

/** Map a registry row to the domain {@link TenantRecord}. */
function toRecord(row: TenantRow): TenantRecord {
  return {
    id: row.id,
    slug: row.slug,
    region: row.region,
    status: row.status,
    neonProjectId: row.neon_project_id,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Options for the Postgres tenant registry. */
export interface PgRegistryOptions {
  /** Control-plane registry connection string (metadata only — never tenant data). */
  connectionString: string;
  /** Max pool size. Defaults to the `pg` default. */
  maxConnections?: number;
  /** Permit a non-TLS connection (local dev only — the documented leaky-endpoint opt-out). */
  allowInsecure?: boolean;
}

/** Directory holding the control-plane registry migrations (resolved relative to this module). */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations', import.meta.url));

/**
 * Create a {@link TenantRegistry} backed by Neon Postgres.
 *
 * All queries are parameterized (no string-built SQL). The pool is least-privilege: it holds the
 * control-plane registry credential only — never a per-tenant or "god" credential (ARCHITECTURE §7).
 *
 * @param options - Connection string and optional pool size.
 * @returns A tenant registry.
 */
export function createPgTenantRegistry(options: PgRegistryOptions): TenantRegistry {
  // Fail closed at startup if the control-plane connection would run over plaintext (master §5).
  assertPostgresTls(options.connectionString, 'DATABASE_URL', options.allowInsecure);
  const pool = new Pool({
    connectionString: options.connectionString,
    ...(options.maxConnections === undefined ? {} : { max: options.maxConnections }),
  });

  return {
    async ping(): Promise<void> {
      // Cheap connectivity check for readiness — touches no tenant data.
      await pool.query('SELECT 1');
    },

    async migrate(): Promise<void> {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS tf_schema_migrations (
           version text PRIMARY KEY,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      const files = readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
        .sort();
      for (const file of files) {
        const version = file.replace(/\.sql$/, '');
        const { rowCount } = await pool.query(
          'SELECT 1 FROM tf_schema_migrations WHERE version = $1',
          [version],
        );
        if (rowCount && rowCount > 0) continue;
        const sql = readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8');
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(sql);
          await client.query('INSERT INTO tf_schema_migrations (version) VALUES ($1)', [version]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      }
    },

    async create(tenant: NewTenant): Promise<TenantRecord> {
      const { rows } = await pool.query<TenantRow>(
        `INSERT INTO tf_tenants (slug, region, metadata)
         VALUES ($1, $2, $3::jsonb)
         RETURNING *`,
        [tenant.slug, tenant.region, JSON.stringify(tenant.metadata ?? {})],
      );
      return toRecord(rows[0]!);
    },

    async getById(id: string): Promise<TenantRecord | null> {
      const { rows } = await pool.query<TenantRow>('SELECT * FROM tf_tenants WHERE id = $1', [id]);
      return rows[0] ? toRecord(rows[0]) : null;
    },

    async getBySlug(slug: string): Promise<TenantRecord | null> {
      const { rows } = await pool.query<TenantRow>('SELECT * FROM tf_tenants WHERE slug = $1', [
        slug,
      ]);
      return rows[0] ? toRecord(rows[0]) : null;
    },

    async list(options?: {
      status?: TenantStatus;
      limit?: number;
      cursor?: { createdAt: Date; id: string };
    }): Promise<TenantRecord[]> {
      const limit = options?.limit ?? 100;
      // Keyset pagination: (created_at, id) strictly less than the cursor, in the same desc order.
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (options?.status) {
        params.push(options.status);
        conditions.push(`status = $${params.length}`);
      }
      if (options?.cursor) {
        params.push(options.cursor.createdAt, options.cursor.id);
        conditions.push(`(created_at, id) < ($${params.length - 1}, $${params.length})`);
      }
      params.push(limit);
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const { rows } = await pool.query<TenantRow>(
        `SELECT * FROM tf_tenants ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
        params,
      );
      return rows.map(toRecord);
    },

    async attachProject(id: string, neonProjectId: string): Promise<void> {
      await pool.query(
        'UPDATE tf_tenants SET neon_project_id = $2, updated_at = now() WHERE id = $1',
        [id, neonProjectId],
      );
    },

    async setStatus(id: string, status: TenantStatus): Promise<void> {
      await pool.query('UPDATE tf_tenants SET status = $2, updated_at = now() WHERE id = $1', [
        id,
        status,
      ]);
    },

    async relocate(id: string, region: string, neonProjectId: string): Promise<void> {
      await pool.query(
        'UPDATE tf_tenants SET region = $2, neon_project_id = $3, updated_at = now() WHERE id = $1',
        [id, region, neonProjectId],
      );
    },

    async registerMigration(migration: {
      version: string;
      checksum: string;
    }): Promise<FleetMigration> {
      // Idempotent by version: insert if absent, then return the stored record (existing wins, so
      // the caller can detect checksum drift).
      await pool.query(
        `INSERT INTO tf_migrations (version, checksum) VALUES ($1, $2)
         ON CONFLICT (version) DO NOTHING`,
        [migration.version, migration.checksum],
      );
      const { rows } = await pool.query<{ id: string; version: string; checksum: string }>(
        'SELECT id, version, checksum FROM tf_migrations WHERE version = $1',
        [migration.version],
      );
      const row = rows[0]!;
      return { id: row.id, version: row.version, checksum: row.checksum };
    },

    async listMigrations(): Promise<FleetMigration[]> {
      const { rows } = await pool.query<{ id: string; version: string; checksum: string }>(
        'SELECT id, version, checksum FROM tf_migrations ORDER BY version ASC',
      );
      return rows.map((r) => ({ id: r.id, version: r.version, checksum: r.checksum }));
    },

    async listTenantMigrationStates(migrationId: string): Promise<TenantMigrationState[]> {
      const { rows } = await pool.query<{
        tenant_id: string;
        migration_id: string;
        status: MigrationStatus;
        error: string | null;
      }>(
        'SELECT tenant_id, migration_id, status, error FROM tf_tenant_migrations WHERE migration_id = $1',
        [migrationId],
      );
      return rows.map((r) => ({
        tenantId: r.tenant_id,
        migrationId: r.migration_id,
        status: r.status,
        ...(r.error !== null ? { error: r.error } : {}),
      }));
    },

    async recordTenantMigration(
      tenantId: string,
      migrationId: string,
      status: MigrationStatus,
      error?: string,
    ): Promise<void> {
      await pool.query(
        `INSERT INTO tf_tenant_migrations (tenant_id, migration_id, status, error, applied_at)
         VALUES ($1, $2, $3, $4, CASE WHEN $3 = 'applied' THEN now() ELSE NULL END)
         ON CONFLICT (tenant_id, migration_id)
         DO UPDATE SET status = EXCLUDED.status, error = EXCLUDED.error, applied_at = EXCLUDED.applied_at`,
        [tenantId, migrationId, status, error ?? null],
      );
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
