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
export {
  compliantRegions,
  selectRegion,
  assertRehomeTarget,
  type RegionSelection,
  type RehomeConstraint,
} from './residency-router.js';
export { isTerminal, canTransition, assertTransition } from './lifecycle.js';
export { encodeCursor, decodeCursor, type TenantCursor } from './pagination.js';
export {
  planSnapshotPrune,
  type RetainableSnapshot,
  type RetentionPolicy,
  type SnapshotPrunePlan,
} from './snapshot.js';
export { evaluateQuota, type Quota, type QuotaBreach, type QuotaStatus } from './quota.js';
export {
  buildComplianceReport,
  type ComplianceReport,
  type ComplianceReportOptions,
  type ComplianceAuditEntry,
} from './compliance.js';
export {
  estimateCostUsd,
  buildCostReport,
  type CostRates,
  type CostReport,
  type TenantCost,
  type TenantUsageRow,
} from './cost.js';
export {
  buildInvoice,
  type BillingRates,
  type Invoice,
  type InvoiceLineItem,
  type InvoiceOptions,
} from './invoice.js';
export { invoiceChargeAmount, chargeIdempotencyKey, type ChargeAmount } from './billing.js';
export {
  can,
  permissionsFor,
  isRole,
  isPermission,
  ROLES,
  PERMISSIONS,
  type Role,
  type Permission,
  type Grant,
} from './authz.js';
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
export {
  computeFleetMigrationDrift,
  type FleetDriftInput,
  type FleetDriftReport,
  type TenantDrift,
  type TenantMigrationProgress,
} from './fleet-drift.js';
export {
  planFleetReconcile,
  type FleetReconcileInput,
  type FleetReconcilePlan,
  type TenantReconcilePlan,
} from './fleet-reconcile.js';
