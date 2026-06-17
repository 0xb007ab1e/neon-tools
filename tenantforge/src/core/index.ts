/**
 * The pure core: deterministic, I/O-free logic (slug/region validation, the tenant-lifecycle state
 * machine, the fleet-migration planner) plus the domain types. Unit-testable without mocks and
 * enforced at 100% coverage (ARCHITECTURE §3, master §4).
 */
export * from './domain.js';
export { isUuid, isValidSlug, normalizeSlug, assertSlug } from './identifiers.js';
export { KNOWN_REGIONS, isValidRegion, assertRegion } from './regions.js';
export { isTerminal, canTransition, assertTransition } from './lifecycle.js';
export { assertRoutable, type RoutableTenant } from './routing.js';
export { retentionCutoff, isPurgeable, type RetainableTenant } from './retention.js';
export { redactSecrets, type TenantEvent } from './observability.js';
export { planFleetMigration, type FleetPlanInput, type FleetMigrationPlan } from './fleet-plan.js';
