import { KNOWN_REGIONS } from './regions.js';

/** A data-residency jurisdiction a tenant's data may be required to stay within. */
export type Jurisdiction = 'us' | 'eu' | 'apac';

/**
 * Which jurisdiction each known Neon region belongs to (data residency — std-privacy). Keep in sync
 * with {@link KNOWN_REGIONS}; a region missing here is a configuration bug surfaced by
 * {@link regionJurisdiction}.
 */
const REGION_JURISDICTION: Readonly<Record<string, Jurisdiction>> = {
  'aws-us-east-1': 'us',
  'aws-us-east-2': 'us',
  'aws-us-west-2': 'us',
  'aws-eu-central-1': 'eu',
  'aws-eu-west-1': 'eu',
  'aws-eu-west-2': 'eu',
  'aws-ap-southeast-1': 'apac',
  'aws-ap-southeast-2': 'apac',
  'aws-ap-northeast-1': 'apac',
  'azure-eastus2': 'us',
  'azure-westus3': 'us',
  'azure-gwc': 'eu', // Germany West Central
};

/**
 * The residency jurisdiction of a known region.
 *
 * @param region - A region id (validate with `assertRegion` first).
 * @returns The region's jurisdiction.
 * @throws Error if the region has no jurisdiction mapping (a config bug — see REGION_JURISDICTION).
 */
export function regionJurisdiction(region: string): Jurisdiction {
  const jurisdiction = REGION_JURISDICTION[region];
  if (jurisdiction === undefined) {
    throw new Error(`no residency jurisdiction mapped for region ${JSON.stringify(region)}`);
  }
  return jurisdiction;
}

/**
 * Assert a region satisfies a required data-residency jurisdiction (e.g. an EU tenant must be in an
 * EU region). Fail closed on a mismatch (std-privacy, master §2).
 *
 * @param region - The chosen region (already validated).
 * @param required - The required jurisdiction.
 * @throws Error if the region's jurisdiction differs from `required`.
 */
export function assertResidency(region: string, required: Jurisdiction): void {
  const actual = regionJurisdiction(region);
  if (actual !== required) {
    throw new Error(
      `region ${region} is in jurisdiction "${actual}", which does not satisfy required residency "${required}"`,
    );
  }
}

/**
 * Assert a region is permitted by an org/deployment allow-list. An **empty** allow-list means no
 * restriction (all known regions allowed); a non-empty one restricts provisioning to its members.
 * Fail closed (master §2).
 *
 * @param region - The chosen region.
 * @param allowed - The allow-listed region ids (empty = unrestricted).
 * @throws Error if `allowed` is non-empty and does not contain `region`.
 */
export function assertRegionAllowed(region: string, allowed: readonly string[]): void {
  if (allowed.length > 0 && !allowed.includes(region)) {
    throw new Error(`region ${region} is not in the allowed set: ${allowed.join(', ')}`);
  }
}

/** All known jurisdictions present in {@link KNOWN_REGIONS} (derived; for validation/listing). */
export const KNOWN_JURISDICTIONS: readonly Jurisdiction[] = [
  ...new Set(KNOWN_REGIONS.map((r) => REGION_JURISDICTION[r]!)),
];
