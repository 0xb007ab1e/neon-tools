import type { SignedEvidenceBundle } from '../core/evidence-bundle.js';
import type { EvidenceManifest, EvidenceManifestFilter } from '../core/evidence-manifest.js';
import type { ObjectStore } from '../ports/object-store.js';
import type { EvidencePutOptions, EvidenceStore } from '../ports/evidence-store.js';
import { createInMemoryEvidenceStore } from './evidence-store.js';

/** Options for {@link createObjectStoreEvidenceStore}. */
export interface ObjectStoreEvidenceStoreOptions {
  /**
   * The durable {@link ObjectStore} the **signed bundle body** is written to at rest (filesystem /
   * S3 / GCS / Azure Blob). **Encryption at rest is this object store's concern** (SSE / KMS-backed
   * bucket / encrypted volume) — the adapter assumes the storage layer encrypts; the body carries no
   * secrets/connection URIs regardless (threat-model B10, master §5).
   */
  objectStore: ObjectStore;
  /**
   * Key prefix to namespace evidence objects within the store (default `evidence`). Keys are
   * `{prefix}/{tenantScope}/{bundleId}.jws.json`, where `tenantScope` is the tenant id for a
   * per-tenant bundle or `fleet` for a fleet bundle — **tenant-scoped at-rest keys** so the Phase 3b
   * authz boundary maps cleanly onto storage, and the `bundleId` segment is **non-guessable**.
   */
  keyPrefix?: string;
}

/** The on-disk/object body envelope written for a stored bundle (manifest facts + the signed body). */
interface StoredEvidenceObject {
  /** The manifest facts (no secrets) — duplicated into the object so it is self-describing at rest. */
  manifest: EvidenceManifest;
  /** The signed bundle (`{ bundle, jws }`) — the JWS is the authenticity anchor. No secrets. */
  signed: SignedEvidenceBundle;
}

/**
 * The at-rest object key for a stored bundle: `{prefix}/{tenantScope}/{bundleId}.jws.json`. The
 * `tenantScope` segment is the manifest's `tenantId` (per-tenant) or `fleet` — tenant-scoped at-rest
 * layout. The `bundleId` is the non-guessable random id, so even the key is unguessable.
 */
function objectKey(prefix: string, manifest: EvidenceManifest): string {
  const scopeSegment = manifest.tenantId ?? 'fleet';
  return `${prefix}/${scopeSegment}/${manifest.bundleId}.jws.json`;
}

/**
 * Create an {@link EvidenceStore} that persists the **signed bundle body to a durable
 * {@link ObjectStore}** (evidence-at-rest) while keeping a queryable {@link EvidenceManifest} index
 * for `get`/`list`/`pruneExpired` (ADR-0011 Phase 3a). Built **on the existing object-store port** —
 * the same seam the off-Neon archive tier uses — so a filesystem / S3 / GCS / Azure-Blob store plugs
 * in unchanged; **encrypt-at-rest is the object store's concern** (SSE / KMS / encrypted volume).
 *
 * The bundle id (and hence the object key) is **non-guessable** and **tenant-scoped**
 * (`{prefix}/{tenant|fleet}/{bundleId}.jws.json`), so a stored bundle can't be enumerated and the
 * Phase 3b access-control surface maps cleanly onto storage. **The store does not authorize** — the
 * BOLA-on-fetch decision is the 3b surface's; `get`/`list` still take a tenant-scope argument so 3b
 * can't bypass per-tenant ownership.
 *
 * **Index durability.** This adapter is built on the **write-only** `ObjectStore` port (`put` only —
 * the same minimal seam the export/archive tier uses, where retrieval is the object store's own
 * console/lifecycle). It therefore keeps the manifest index (and a retained body copy for `get`)
 * in-process and writes the canonical body durably at rest on every `put`. A future read-capable
 * object-store port (or a Postgres manifest index, mirroring the `pending-erasure` pg adapter) can
 * make `get`/`list` survive a restart from the durable objects alone — the body is already durable;
 * only the *index* is in-process today. `pruneExpired` removes the index entry; **deleting the
 * at-rest object is the object store's lifecycle policy** (S3/GCS retention), exactly as the archive
 * tier documents — this adapter does not delete from a write-only object store. **Ops note:** because
 * prune drops only the index, a pruned bundle's body remains at rest as an **orphan** until the
 * bucket's own lifecycle/retention policy reaps it — configure that policy to match
 * `TENANTFORGE_EVIDENCE_RETENTION_DAYS` so expired evidence is actually deleted at rest.
 *
 * @param options - The durable object store + optional key prefix.
 * @returns An object-store-backed evidence store.
 */
export function createObjectStoreEvidenceStore(
  options: ObjectStoreEvidenceStoreOptions,
): EvidenceStore {
  const prefix = (options.keyPrefix ?? 'evidence').replace(/^\/+|\/+$/g, '');
  // Reuse the in-memory store for the manifest index + scoped get/list/prune semantics (one source of
  // truth for scoping + retention math); this adapter adds the durable at-rest write on top.
  const index = createInMemoryEvidenceStore();

  return {
    async put(signed: SignedEvidenceBundle, opts: EvidencePutOptions): Promise<EvidenceManifest> {
      // Mint the manifest (non-guessable id, retention, scope) via the index store first, then write
      // the canonical body durably at rest under the tenant-scoped, non-guessable key.
      const manifest = await index.put(signed, opts);
      const body: StoredEvidenceObject = { manifest, signed };
      await options.objectStore.put(
        objectKey(prefix, manifest),
        Buffer.from(JSON.stringify(body), 'utf8'),
      );
      return manifest;
    },

    get(bundleId: string, tenantScope: string | null): Promise<SignedEvidenceBundle | null> {
      // Tenant-scoped read from the index (which retains the body). The durable object is the
      // canonical at-rest copy; index-backed get keeps the same scoping guard as the memory adapter.
      return index.get(bundleId, tenantScope);
    },

    list(filter?: EvidenceManifestFilter): Promise<EvidenceManifest[]> {
      return index.list(filter);
    },

    pruneExpired(now: Date, limit?: number): Promise<number> {
      // Remove expired index entries. The at-rest object's deletion is the object store's own
      // lifecycle/retention policy (S3/GCS) — the write-only port exposes no delete (archive-tier
      // precedent). The index no longer surfaces a pruned bundle via get/list (fail closed on read).
      return index.pruneExpired(now, limit);
    },
  };
}
