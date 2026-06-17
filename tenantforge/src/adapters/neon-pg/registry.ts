import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import type { JsonObject, TenantRecord, TenantStatus } from '../../core/domain.js';
import type { NewTenant, TenantRegistry } from '../../ports/tenant-registry.js';

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
  const pool = new Pool({
    connectionString: options.connectionString,
    ...(options.maxConnections === undefined ? {} : { max: options.maxConnections }),
  });

  return {
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

    async list(options?: { status?: TenantStatus; limit?: number }): Promise<TenantRecord[]> {
      const limit = options?.limit ?? 100;
      if (options?.status) {
        const { rows } = await pool.query<TenantRow>(
          'SELECT * FROM tf_tenants WHERE status = $1 ORDER BY created_at DESC LIMIT $2',
          [options.status, limit],
        );
        return rows.map(toRecord);
      }
      const { rows } = await pool.query<TenantRow>(
        'SELECT * FROM tf_tenants ORDER BY created_at DESC LIMIT $1',
        [limit],
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

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
