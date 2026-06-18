/**
 * The pure core: deterministic, I/O-free logic (slug/region validation, the tenant-lifecycle state
 * machine, the fleet-migration planner) plus the domain types. Unit-testable without mocks and
 * enforced at 100% coverage (ARCHITECTURE §3, master §4).
 */
export * from './domain.js';
export { isUuid, isValidSlug, normalizeSlug, assertSlug } from './identifiers.js';
export { KNOWN_REGIONS, isValidRegion, assertRegion } from './regions.js';
export {
  regionJurisdiction,
  assertResidency,
  assertRegionAllowed,
  KNOWN_JURISDICTIONS,
  type Jurisdiction,
} from './residency.js';
export { compliantRegions, selectRegion, type RegionSelection } from './residency-router.js';
export { isTerminal, canTransition, assertTransition } from './lifecycle.js';
export { assertRoutable, type RoutableTenant } from './routing.js';
export { retentionCutoff, isPurgeable, type RetainableTenant } from './retention.js';
export { redactSecrets, type TenantEvent } from './observability.js';
export {
  buildErasureCertificate,
  type ErasureCertificate,
  type ErasureVerification,
  type ErasureSteps,
} from './erasure.js';
export {
  assertPeriod,
  aggregateConsumption,
  type BillingPeriod,
  type Consumption,
  type TenantUsage,
} from './usage.js';
export { planFleetMigration, type FleetPlanInput, type FleetMigrationPlan } from './fleet-plan.js';
