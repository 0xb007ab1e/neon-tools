import type { SignedEvidenceBundle } from '../core/evidence-bundle.js';
import type { EvidenceManifest, EvidenceManifestFilter } from '../core/evidence-manifest.js';

/** Options for {@link EvidenceStore.put}. */
export interface EvidencePutOptions {
  /** The signing key id (`kid`) the bundle's JWS was signed under — recorded in the manifest. */
  signerKid: string;
  /** When the bundle is persisted (injected for determinism); defaults to now in adapters. */
  storedAt?: Date;
  /**
   * Whole days to retain before the bundle is eligible for {@link EvidenceStore.pruneExpired};
   * `0`/omitted ⇒ **indefinite** retention (no `retentionUntil`). Drives
   * {@link import('../core/evidence-manifest.js').evidenceRetentionUntil}.
   */
  retentionDays?: number;
}

/**
 * Port: **evidence-at-rest** for signed compliance bundles (ADR-0011 Phase 3a). Persists a
 * {@link SignedEvidenceBundle} (`{ bundle, jws }`) under a **non-guessable, random, tenant-scoped**
 * key and exposes a queryable {@link EvidenceManifest} index, plus a retention sweep.
 *
 * **This is a low-level capability, NOT an access-controlled surface.** `get`/`list` exist so the
 * **Phase 3b** retrieval surface (CLI/HTTP/portal) can be built on top — but in this slice they are
 * **not surfaced outward**: there is no CLI/HTTP/MCP read of a bundle yet. **Access control (the
 * BOLA-on-fetch boundary) lives at the 3b surface, not here.** `get` and `list` still take a
 * **tenant-scope** argument deliberately, so the 3b surface cannot accidentally bypass per-tenant
 * ownership: a per-tenant fetch passes the server-derived tenant id and the store refuses to return a
 * bundle that doesn't match it (complete mediation, defense in depth — even though the store doesn't
 * decide *who* may ask).
 *
 * **Confidentiality.** The bundle body is a **confidential** artifact (tenant ids, residency, an
 * audit excerpt — threat-model B10) but carries no secrets/connection URIs. **Encryption at rest is
 * the underlying object store's concern** (S3/GCS SSE / a KMS-backed bucket / an encrypted volume);
 * this port assumes the storage layer it is built on encrypts at rest, and the manifest itself holds
 * facts only (master §5). The default adapter is in-memory (dev/test); an object-store-backed adapter
 * writes the body durably and keeps the manifest index (mirrors the `pending-erasure` dual-backend
 * pattern, config-selected via `TENANTFORGE_EVIDENCE_STORE`).
 */
export interface EvidenceStore {
  /**
   * Persist a signed bundle under a freshly-minted **non-guessable** id and return its
   * {@link EvidenceManifest} (facts only — no JWS body, no secrets). The id is random (128 bits),
   * **not** sequential/predictable, so a stored bundle cannot be enumerated (the F7/L3 lesson). For a
   * per-tenant bundle the manifest's `tenantId` is taken from the bundle's own `tenantId`
   * (server-derived upstream), so the key/index is tenant-scoped for 3b's authz.
   *
   * @param signed - The signed evidence bundle to persist.
   * @param opts - The signer `kid`, an optional `storedAt` clock, and a retention window (days).
   * @returns The manifest indexing the just-stored bundle.
   */
  put(signed: SignedEvidenceBundle, opts: EvidencePutOptions): Promise<EvidenceManifest>;

  /**
   * Fetch a stored signed bundle by id, **scoped to a tenant**. Returns the bundle only when it
   * exists **and** the scope matches: a `tenantScope` of a tenant id returns the bundle iff it is
   * that tenant's; a `tenantScope` of `null` is the **operator (fleet) scope** and may fetch any
   * bundle (fleet or tenant). A tenant-scoped fetch of another tenant's (or a fleet) bundle returns
   * `null` — never the wrong tenant's evidence (the store-level half of BOLA defense; the *authz
   * decision* of which scope a caller gets is the 3b surface's job).
   *
   * @param bundleId - The non-guessable id from a {@link EvidenceManifest}.
   * @param tenantScope - The tenant id to scope to, or `null` for operator/fleet scope.
   * @returns The signed bundle, or `null` if unknown or out of the requested scope.
   */
  get(bundleId: string, tenantScope: string | null): Promise<SignedEvidenceBundle | null>;

  /**
   * List manifests matching `filter`, newest-stored first, bounded by `filter.limit` (clamped — no
   * unbounded result set). Returns **facts only**. A `filter.tenantId` restricts to one tenant's
   * bundles; the **3b surface must set it from the server-derived principal** when a tenant lists its
   * own evidence (the store filters, it does not authorize).
   *
   * @param filter - Optional scope / tenant / limit constraints.
   * @returns The matching manifests, newest-stored first.
   */
  list(filter?: EvidenceManifestFilter): Promise<EvidenceManifest[]>;

  /**
   * **Retention sweep:** irreversibly remove every stored bundle (body + index) whose
   * `retentionUntil` is at/before `now`, returning the count removed. Idempotent and batched — safe
   * to run repeatedly (a second run removes nothing new), bounded per call. Bundles with no
   * `retentionUntil` (indefinite retention) are never pruned. Eligibility uses the shared pure
   * {@link import('../core/evidence-manifest.js').isEvidenceExpired} so every adapter agrees.
   *
   * @param now - The current instant (injected for determinism).
   * @param limit - Max bundles to prune this call (default in adapters; bounds the sweep).
   * @returns The number of bundles pruned.
   */
  pruneExpired(now: Date, limit?: number): Promise<number>;
}
