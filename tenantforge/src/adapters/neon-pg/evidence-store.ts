import { Pool } from 'pg';
import { assertPostgresTls } from '../../core/transport-security.js';
import type { SignedEvidenceBundle } from '../../core/evidence-bundle.js';
import {
  evidenceRetentionUntil,
  type EvidenceManifest,
  type EvidenceManifestFilter,
} from '../../core/evidence-manifest.js';
import type { EvidencePutOptions, EvidenceStore } from '../../ports/evidence-store.js';
import { mintEvidenceBundleId } from '../evidence-store.js';

/** A Postgres-backed {@link EvidenceStore}, plus `close`. */
export interface PgEvidenceStore extends EvidenceStore {
  /** Release the connection pool. */
  close(): Promise<void>;
}

/** Options for {@link createPgEvidenceStore}. */
export interface PgEvidenceStoreOptions {
  /** Control-plane Postgres connection string (the `tf_evidence_bundles` table lives here). */
  connectionString: string;
  /** Max pool size. */
  maxConnections?: number;
  /** Permit a non-TLS connection (local dev only — the documented leaky-endpoint opt-out). */
  allowInsecure?: boolean;
}

/** Default page size for {@link EvidenceStore.list} and prune-sweep batches. */
const DEFAULT_LIMIT = 100;
/** Hard upper bound on a single list/prune call (DoS control — never an unbounded scan). */
const MAX_LIMIT = 1000;

/** Clamp a requested limit to `[1, MAX_LIMIT]`, defaulting when omitted (mirrors the in-memory store). */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

/** A `tf_evidence_bundles` row (the manifest facts; the signed body is selected separately). */
interface ManifestRow {
  bundle_id: string;
  scope: 'fleet' | 'tenant';
  tenant_id: string | null;
  generated_at: Date;
  stored_at: Date;
  signer_kid: string;
  content_hashes: EvidenceManifest['contentHashes'];
  retention_until: Date | null;
}

/** Map a DB row to an {@link EvidenceManifest} (facts only — omitting null/cleared optionals). */
function toManifest(r: ManifestRow): EvidenceManifest {
  return {
    bundleId: r.bundle_id,
    scope: r.scope,
    ...(r.tenant_id !== null ? { tenantId: r.tenant_id } : {}),
    generatedAt: r.generated_at.toISOString(),
    storedAt: r.stored_at.toISOString(),
    signerKid: r.signer_kid,
    contentHashes: { ...r.content_hashes },
    ...(r.retention_until !== null ? { retentionUntil: r.retention_until.toISOString() } : {}),
  };
}

/** The manifest columns selected for every list/read (explicit — no `SELECT *`, never the body on list). */
const MANIFEST_COLUMNS =
  'bundle_id, scope, tenant_id, generated_at, stored_at, signer_kid, content_hashes, retention_until';

/**
 * Create an {@link EvidenceStore} backed by Neon Postgres (`tf_evidence_bundles`, migration 0013) —
 * **durable across restarts and across replicas** (ADR-0011 Phase 3b). This is the durable manifest
 * index that closes the Phase 3a gap: the object-store adapter kept its manifest index in-process (the
 * write-only `ObjectStore` port), so `get`/`list`/`pruneExpired` did not survive a restart. Here the
 * manifest **and** the no-secret signed body live in Postgres (`body jsonb`), so retrieval + prune are
 * durable — mirroring the pg pending-erasure adapter.
 *
 * **Holds no secrets** (master §5): the `body` is the **signed** bundle (`{ bundle, jws }`) —
 * attestation facts + its EdDSA signature, never a connection URI or signing key. The bundle is
 * **confidential** (tenant ids/residency) but secret-free, and the table lives in the metadata
 * control-plane DB (never tenant content). `tenant_id` has **no FK** to `tf_tenants` — evidence must
 * outlive the tenant it attests, so a purge never cascade-deletes evidence.
 *
 * **Access control is enforced at the Phase 3b surface, not here** (the BOUNDARY NOTE on the port).
 * `get(bundleId, tenantScope)` still takes a tenant scope so the surface cannot bypass per-tenant
 * ownership: a tenant-scoped fetch returns a bundle iff it is that tenant's; `tenantScope = null` is
 * the operator/fleet scope. The store filters/scopes; it does not decide *who* may ask.
 *
 * @param options - Connection string and optional pool size / TLS opt-out.
 * @returns A Postgres-backed evidence store.
 */
export function createPgEvidenceStore(options: PgEvidenceStoreOptions): PgEvidenceStore {
  assertPostgresTls(options.connectionString, 'DATABASE_URL', options.allowInsecure);
  const pool = new Pool({
    connectionString: options.connectionString,
    ...(options.maxConnections === undefined ? {} : { max: options.maxConnections }),
  });

  return {
    async put(signed: SignedEvidenceBundle, opts: EvidencePutOptions): Promise<EvidenceManifest> {
      const storedAt = opts.storedAt ?? new Date();
      const bundleId = mintEvidenceBundleId();
      const retentionUntil = evidenceRetentionUntil(storedAt, opts.retentionDays);
      // tenant_id comes from the bundle itself (server-derived upstream) — tenant-scoped index.
      const tenantId = signed.bundle.tenantId ?? null;
      const { rows } = await pool.query<ManifestRow>(
        `INSERT INTO tf_evidence_bundles
           (bundle_id, scope, tenant_id, generated_at, stored_at, signer_kid, content_hashes,
            retention_until, body)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING ${MANIFEST_COLUMNS}`,
        [
          bundleId,
          signed.bundle.scope,
          tenantId,
          signed.bundle.generatedAt,
          storedAt.toISOString(),
          opts.signerKid,
          JSON.stringify(signed.bundle.contentHashes),
          retentionUntil ?? null,
          JSON.stringify(signed),
        ],
      );
      // The RETURNING row always exists for a successful INSERT.
      return toManifest(rows[0]!);
    },

    async get(bundleId: string, tenantScope: string | null): Promise<SignedEvidenceBundle | null> {
      // Tenant-scoped read: a non-null scope additionally requires the row's tenant_id to match, so a
      // tenant-scoped fetch never returns another tenant's (or a fleet) bundle — the store-level half
      // of BOLA defense (the authz *decision* of which scope a caller gets is the 3b surface's job).
      // `tenantScope = null` is operator/fleet scope and may fetch any bundle.
      const { rows } = await pool.query<{ body: SignedEvidenceBundle }>(
        tenantScope === null
          ? `SELECT body FROM tf_evidence_bundles WHERE bundle_id = $1`
          : `SELECT body FROM tf_evidence_bundles WHERE bundle_id = $1 AND tenant_id = $2`,
        tenantScope === null ? [bundleId] : [bundleId, tenantScope],
      );
      const row = rows[0];
      if (row === undefined) return null;
      // The stored body is the canonical signed bundle; return a structural copy (no shared mutable
      // state across calls). jsonb round-trips to the same shape the verifier reconstructs.
      return { bundle: row.body.bundle, jws: row.body.jws };
    },

    async list(filter?: EvidenceManifestFilter): Promise<EvidenceManifest[]> {
      const limit = clampLimit(filter?.limit);
      // Build a bounded, parameterized query (no string-built predicates). Newest-stored first.
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (filter?.scope !== undefined) {
        params.push(filter.scope);
        conditions.push(`scope = $${params.length}`);
      }
      if (filter?.tenantId !== undefined) {
        params.push(filter.tenantId);
        conditions.push(`tenant_id = $${params.length}`);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(limit);
      const { rows } = await pool.query<ManifestRow>(
        `SELECT ${MANIFEST_COLUMNS} FROM tf_evidence_bundles
         ${where}
         ORDER BY stored_at DESC, bundle_id ASC
         LIMIT $${params.length}`,
        params,
      );
      return rows.map(toManifest);
    },

    async pruneExpired(now: Date, limit?: number): Promise<number> {
      // Irreversibly remove expired rows (body + index together — the body lives in the same row).
      // Bounded per call (DoS control). Rows with NULL retention_until (indefinite) are never matched.
      // A single bounded DELETE … WHERE bundle_id IN (bounded SELECT) so the cap is honored atomically.
      const cap = clampLimit(limit);
      const { rowCount } = await pool.query(
        `DELETE FROM tf_evidence_bundles
         WHERE bundle_id IN (
           SELECT bundle_id FROM tf_evidence_bundles
           WHERE retention_until IS NOT NULL AND retention_until <= $1
           ORDER BY retention_until ASC
           LIMIT $2
         )`,
        [now.toISOString(), cap],
      );
      return rowCount ?? 0;
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
