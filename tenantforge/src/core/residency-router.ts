import { KNOWN_REGIONS } from './regions.js';
import { regionJurisdiction, type Jurisdiction } from './residency.js';

/** A request to choose a provisioning region under residency + allow-list constraints. */
export interface RegionSelection {
  /** Required data-residency jurisdiction; when set, only regions in it are eligible. */
  jurisdiction?: Jurisdiction;
  /** Org/deployment allow-list (empty/omitted = all known regions are eligible). */
  allowed?: readonly string[];
  /**
   * A preferred region (e.g. the deployment's default). Used when it is itself compliant; otherwise
   * the first compliant region (in {@link KNOWN_REGIONS} order) is chosen — the router never returns
   * a non-compliant region.
   */
  preferred?: string;
}

/**
 * The regions that satisfy a {@link RegionSelection}: the allow-list (or all known regions when the
 * allow-list is empty) intersected with the required jurisdiction, in {@link KNOWN_REGIONS} order
 * (deterministic). Pure — the policy half of the ResidencyRouter.
 *
 * @param selection - The jurisdiction + allow-list constraints (`preferred` is ignored here).
 * @returns The compliant region ids, possibly empty.
 */
export function compliantRegions(selection: RegionSelection): string[] {
  const allowed = selection.allowed ?? [];
  // Build candidates from the KNOWN set (so an unknown allow-list entry is ignored, not selected),
  // restricted to the allow-list when one is given.
  const base =
    allowed.length > 0 ? KNOWN_REGIONS.filter((region) => allowed.includes(region)) : KNOWN_REGIONS;
  if (selection.jurisdiction === undefined) return [...base];
  return base.filter((region) => regionJurisdiction(region) === selection.jurisdiction);
}

/**
 * Select a single provisioning region satisfying the residency + allow-list constraints — the
 * ResidencyRouter (#16). Fail closed: if no region is compliant, throw rather than provision into a
 * non-compliant region (std-privacy, master §2). When `preferred` is compliant it wins (stable
 * placement); otherwise the first compliant region is chosen deterministically.
 *
 * This complements the assert-style residency checks (`assertResidency` / `assertRegionAllowed`),
 * which validate an *explicitly chosen* region; the router *chooses* one from a jurisdiction.
 *
 * @param selection - The jurisdiction, allow-list, and optional preferred region.
 * @returns A compliant region id.
 * @throws Error if no known, allow-listed region satisfies the jurisdiction.
 */
export function selectRegion(selection: RegionSelection): string {
  const allowed = selection.allowed ?? [];
  const candidates = compliantRegions(selection);
  if (candidates.length === 0) {
    throw new Error(
      `no region satisfies residency "${selection.jurisdiction ?? 'any'}" within the allowed regions [${allowed.join(', ')}]`,
    );
  }
  if (selection.preferred !== undefined && candidates.includes(selection.preferred)) {
    return selection.preferred;
  }
  return candidates[0]!;
}
