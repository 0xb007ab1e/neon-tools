import { randomBytes } from 'node:crypto';
import type { SignedEvidenceBundle } from '../core/evidence-bundle.js';
import {
  EVIDENCE_BUNDLE_ID_BYTES,
  evidenceRetentionUntil,
  isEvidenceExpired,
  type EvidenceManifest,
  type EvidenceManifestFilter,
} from '../core/evidence-manifest.js';
import type { EvidencePutOptions, EvidenceStore } from '../ports/evidence-store.js';

/** An in-memory {@link EvidenceStore} (default / tests), plus a `clear` test helper. */
export interface InMemoryEvidenceStore extends EvidenceStore {
  /** Drop all stored bundles + manifests (test helper). */
  clear(): void;
}

/** Default page size for {@link EvidenceStore.list} and prune-sweep batches. */
const DEFAULT_LIMIT = 100;
/** Hard upper bound on a single list/prune call (DoS control — never an unbounded scan). */
const MAX_LIMIT = 1000;

/** Clamp a requested limit to `[1, MAX_LIMIT]`, defaulting when omitted. */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

/**
 * Mint a **non-guessable** evidence bundle id: 128 bits of CSPRNG entropy, hex-encoded. Random — NOT
 * sequential/predictable — so a stored bundle cannot be enumerated by guessing ids (the F7/L3
 * lesson). Shared by every adapter so the key shape is uniform.
 *
 * @returns A fresh random bundle id.
 */
export function mintEvidenceBundleId(): string {
  return randomBytes(EVIDENCE_BUNDLE_ID_BYTES).toString('hex');
}

/** Whether a stored manifest matches a list filter (scope/tenant). */
function matchesFilter(m: EvidenceManifest, filter: EvidenceManifestFilter | undefined): boolean {
  if (filter === undefined) return true;
  if (filter.scope !== undefined && m.scope !== filter.scope) return false;
  if (filter.tenantId !== undefined && m.tenantId !== filter.tenantId) return false;
  return true;
}

/**
 * Create an in-memory {@link EvidenceStore} — process-local, for dev / single-instance / tests
 * (mirrors {@link import('./pending-erasure-store.js').createInMemoryPendingErasureStore}). Holds the
 * signed bundle body + its manifest in a `Map` keyed by the **non-guessable** bundle id; `get`/`list`
 * are tenant-scoped at the store level and `pruneExpired` uses the shared pure expiry predicate so it
 * agrees with any persistent adapter. Stored copies are deep-ish-cloned at the boundary (structural
 * fields) so a caller can't mutate the store's state.
 *
 * The body is a **confidential** artifact (no secrets/connection URIs — threat-model B10); encryption
 * at rest is N/A for an in-memory store (process memory only — never use it for durable production
 * evidence; that is the object-store-backed adapter's job).
 *
 * @returns The in-memory evidence store.
 */
export function createInMemoryEvidenceStore(): InMemoryEvidenceStore {
  /** bundleId → { manifest, signed body }. */
  const byId = new Map<string, { manifest: EvidenceManifest; signed: SignedEvidenceBundle }>();

  const cloneManifest = (m: EvidenceManifest): EvidenceManifest => ({
    ...m,
    contentHashes: { ...m.contentHashes },
  });

  return {
    put(signed: SignedEvidenceBundle, opts: EvidencePutOptions): Promise<EvidenceManifest> {
      const storedAt = opts.storedAt ?? new Date();
      const bundleId = mintEvidenceBundleId();
      const retentionUntil = evidenceRetentionUntil(storedAt, opts.retentionDays);
      const manifest: EvidenceManifest = {
        bundleId,
        scope: signed.bundle.scope,
        // tenantId comes from the bundle itself (server-derived upstream) — tenant-scoped index.
        ...(signed.bundle.tenantId !== undefined ? { tenantId: signed.bundle.tenantId } : {}),
        generatedAt: signed.bundle.generatedAt,
        storedAt: storedAt.toISOString(),
        signerKid: opts.signerKid,
        contentHashes: { ...signed.bundle.contentHashes },
        ...(retentionUntil !== undefined ? { retentionUntil } : {}),
      };
      // Store a defensive copy of the body so the caller can't mutate the persisted bundle.
      byId.set(bundleId, {
        manifest,
        signed: { bundle: structuredClone(signed.bundle), jws: signed.jws },
      });
      return Promise.resolve(cloneManifest(manifest));
    },

    get(bundleId: string, tenantScope: string | null): Promise<SignedEvidenceBundle | null> {
      const entry = byId.get(bundleId);
      if (entry === undefined) return Promise.resolve(null);
      // Tenant-scoped fetch: only the matching tenant's bundle is returned (never the wrong tenant's
      // or a fleet bundle). `null` scope is operator/fleet scope — may fetch any bundle. The *authz*
      // of which scope a caller gets is the Phase 3b surface's decision; this is the store-level guard.
      if (tenantScope !== null && entry.manifest.tenantId !== tenantScope) {
        return Promise.resolve(null);
      }
      return Promise.resolve({
        bundle: structuredClone(entry.signed.bundle),
        jws: entry.signed.jws,
      });
    },

    list(filter?: EvidenceManifestFilter): Promise<EvidenceManifest[]> {
      const limit = clampLimit(filter?.limit);
      const rows = [...byId.values()]
        .map((e) => e.manifest)
        .filter((m) => matchesFilter(m, filter))
        // Newest-stored first; ties broken by id for a stable order.
        .sort((a, b) =>
          a.storedAt > b.storedAt
            ? -1
            : a.storedAt < b.storedAt
              ? 1
              : a.bundleId.localeCompare(b.bundleId),
        )
        .slice(0, limit)
        .map(cloneManifest);
      return Promise.resolve(rows);
    },

    pruneExpired(now: Date, limit?: number): Promise<number> {
      const cap = clampLimit(limit);
      let removed = 0;
      for (const [id, entry] of byId) {
        if (removed >= cap) break;
        if (isEvidenceExpired(entry.manifest, now)) {
          byId.delete(id);
          removed += 1;
        }
      }
      return Promise.resolve(removed);
    },

    clear(): void {
      byId.clear();
    },
  };
}
