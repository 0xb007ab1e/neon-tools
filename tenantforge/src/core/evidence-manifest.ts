import type { EvidenceContentHashes, EvidenceScope } from './evidence-bundle.js';

/**
 * The **queryable index record** for a persisted evidence bundle (ADR-0011 Phase 3a). It holds the
 * **facts** about a stored bundle — never the JWS body, never secrets — so an index can be listed,
 * filtered, and retention-swept without re-hydrating (or trusting) the bundle itself.
 *
 * It is the manifest an operator/auditor browses; the signed bundle body (`SignedEvidenceBundle`,
 * `{ bundle, jws }`) lives separately in the evidence store (the object store at rest). The
 * `bundleId` is a **non-guessable, random** key (NOT sequential — the F7/L3 lesson) and the
 * `tenantId` (for a per-tenant bundle) is part of the index so the **Phase 3b** retrieval surface
 * can enforce per-tenant ownership (BOLA). **This manifest carries no secrets and no connection
 * URIs** (master §5) — the same discipline as the bundle it indexes.
 */
export interface EvidenceManifest {
  /**
   * The **non-guessable, random** bundle id — the storage key + the handle a retrieval surface
   * dereferences. Never sequential/predictable (so a bundle can't be enumerated — the F7/L3 lesson);
   * minted by {@link mintEvidenceBundleId}.
   */
  bundleId: string;
  /** Whether the indexed bundle covers the whole fleet or a single tenant. */
  scope: EvidenceScope;
  /**
   * The scoped tenant id — present **iff** `scope === 'tenant'` (server-derived; never
   * client-supplied). Indexed so Phase 3b can enforce tenant ownership on fetch (BOLA).
   */
  tenantId?: string;
  /** When the indexed bundle was generated (ISO-8601 UTC — copied from the bundle). */
  generatedAt: string;
  /** When the bundle was persisted into the store (ISO-8601 UTC; the index/at-rest timestamp). */
  storedAt: string;
  /**
   * The signing key id (`kid`) the bundle's JWS was signed under — a fact for auditors/operators to
   * correlate a stored bundle to a published public key. Not a secret.
   */
  signerKid: string;
  /**
   * Per-artifact SHA-256 (hex) content hashes copied from the bundle — lets a consumer spot-check a
   * stored bundle's parts via the index without fetching the whole body. The bundle's own EdDSA
   * signature remains the authoritative authenticity anchor.
   */
  contentHashes: EvidenceContentHashes;
  /**
   * When the stored bundle becomes eligible for retention pruning (ISO-8601 UTC), or omitted for an
   * indefinitely-retained bundle. Computed from {@link evidenceRetentionUntil} at persist time.
   */
  retentionUntil?: string;
}

/** A read filter for listing manifests (all fields optional; omitted = unconstrained). */
export interface EvidenceManifestFilter {
  /** Restrict to a single scope (`fleet` or `tenant`). */
  scope?: EvidenceScope;
  /**
   * Restrict to a single tenant's bundles. **The Phase 3b retrieval surface MUST set this from the
   * server-derived principal** when listing a tenant's own evidence — the store does not itself
   * authorize, it only filters (access control lives at the 3b surface).
   */
  tenantId?: string;
  /** Max rows to return (the store clamps to a sane bound; unbounded reads are a DoS surface). */
  limit?: number;
}

/** Number of random bytes in an evidence bundle id (128 bits of entropy — non-guessable). */
export const EVIDENCE_BUNDLE_ID_BYTES = 16;

/** Milliseconds in a day — retention is expressed in whole days. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Compute the retention deadline for a stored bundle: `storedAt + retentionDays` (ISO-8601 UTC),
 * or `undefined` for **indefinite** retention when `retentionDays` is `0`/omitted (an explicit "keep
 * forever" — never an accidental immediate expiry). **Pure** and deterministic (the clock is the
 * caller's `storedAt`).
 *
 * @param storedAt - When the bundle was persisted.
 * @param retentionDays - Whole days to retain; `0`/omitted ⇒ indefinite (returns `undefined`).
 * @returns The ISO-8601 retention deadline, or `undefined` for indefinite retention.
 * @throws Error if `retentionDays` is negative or non-integer (fail closed — an invalid policy must
 *   not silently collapse to "keep forever" or "expire now").
 */
export function evidenceRetentionUntil(
  storedAt: Date,
  retentionDays: number | undefined,
): string | undefined {
  if (retentionDays === undefined || retentionDays === 0) return undefined;
  if (!Number.isInteger(retentionDays) || retentionDays < 0) {
    throw new Error(`evidenceRetentionUntil: retentionDays must be a non-negative integer`);
  }
  return new Date(storedAt.getTime() + retentionDays * DAY_MS).toISOString();
}

/**
 * Whether a manifest is **expired** at instant `now` — i.e. its `retentionUntil` is set and has
 * passed (`retentionUntil <= now`). A manifest with no `retentionUntil` (indefinite retention) is
 * **never** expired. **Pure** and deterministic; the comparison is the single source of truth shared
 * by every {@link EvidenceStore} adapter's `pruneExpired`, so memory and persistent backends agree
 * exactly on eligibility.
 *
 * @param manifest - The manifest to test.
 * @param now - The current instant.
 * @returns True iff the manifest has a retention deadline at/before `now`.
 */
export function isEvidenceExpired(manifest: EvidenceManifest, now: Date): boolean {
  if (manifest.retentionUntil === undefined) return false;
  return Date.parse(manifest.retentionUntil) <= now.getTime();
}
