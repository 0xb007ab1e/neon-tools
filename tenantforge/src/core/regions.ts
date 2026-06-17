/**
 * Known Neon regions a tenant project may be provisioned in. The region is a data-residency
 * decision (privacy/compliance — ARCHITECTURE §7), so it is validated against an allow-list rather
 * than passed through to the Neon API unchecked.
 *
 * This list mirrors Neon's published region ids; extend it as Neon adds regions.
 */
export const KNOWN_REGIONS: readonly string[] = [
  'aws-us-east-1',
  'aws-us-east-2',
  'aws-us-west-2',
  'aws-eu-central-1',
  'aws-eu-west-1',
  'aws-eu-west-2',
  'aws-ap-southeast-1',
  'aws-ap-southeast-2',
  'aws-ap-northeast-1',
  'azure-eastus2',
  'azure-westus3',
  'azure-gwc',
] as const;

/** Fast membership set for {@link isValidRegion}. */
const REGION_SET: ReadonlySet<string> = new Set(KNOWN_REGIONS);

/**
 * Whether a region id is one TenantForge will provision into.
 *
 * @param value - The candidate region id (e.g. `aws-us-east-1`).
 * @returns True if the region is on the allow-list.
 */
export function isValidRegion(value: string): boolean {
  return REGION_SET.has(value);
}

/**
 * Validate a region id, returning it or throwing.
 *
 * @param value - The candidate region id.
 * @returns The validated region id.
 * @throws Error if the region is not on the allow-list.
 */
export function assertRegion(value: string): string {
  if (!isValidRegion(value)) {
    throw new Error(
      `unknown region ${JSON.stringify(value)}: expected one of ${KNOWN_REGIONS.join(', ')}`,
    );
  }
  return value;
}
