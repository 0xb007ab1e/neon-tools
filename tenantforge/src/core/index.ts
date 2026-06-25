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
  auditEntries,
  inventoryByStatus,
  buildIsolationAttestation,
  buildResidencyAttestation,
  type ComplianceReport,
  type ComplianceReportOptions,
  type ComplianceAuditEntry,
  type ComplianceInventory,
  type ComplianceIsolation,
  type ComplianceResidency,
} from './compliance.js';
export {
  verifyComplianceReport,
  complianceReportClaims,
  COMPLIANCE_REPORT_ALG,
  COMPLIANCE_REPORT_TYP,
  type SignedComplianceReport,
} from './compliance-cert.js';
export {
  buildEvidenceBundle,
  evidenceBundleClaims,
  verifyEvidenceBundle,
  EVIDENCE_BUNDLE_ALG,
  EVIDENCE_BUNDLE_TYP,
  type EvidenceBundle,
  type SignedEvidenceBundle,
  type EvidenceArtifacts,
  type EvidenceContentHashes,
  type EvidenceScope,
  type BuildEvidenceBundleOptions,
} from './evidence-bundle.js';
export {
  evidenceRetentionUntil,
  isEvidenceExpired,
  EVIDENCE_BUNDLE_ID_BYTES,
  type EvidenceManifest,
  type EvidenceManifestFilter,
} from './evidence-manifest.js';
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
  applyIncludedAllowance,
  type BillingRates,
  type IncludedUsage,
  type Invoice,
  type InvoiceLineItem,
  type InvoiceOptions,
} from './invoice.js';
export {
  invoiceChargeAmount,
  chargeIdempotencyKey,
  assertRefundAmount,
  refundIdempotencyKey,
  prorateRefundMinor,
  proratePlanChangeMinor,
  type ChargeAmount,
  type ProrationInput,
  type PlanChangeInput,
} from './billing.js';
export {
  renderReceipt,
  receiptIdempotencyKey,
  formatMoney,
  type ReceiptKind,
  type ReceiptData,
  type RenderedReceipt,
} from './receipts.js';
export {
  renderInvoiceEmail,
  invoiceEmailIdempotencyKey,
  type InvoiceEmailData,
  type RenderedInvoiceEmail,
} from './invoice-email.js';
export { creditBalanceMinor, creditToApply, type CreditEntryAmount } from './credit.js';
export { evaluateUsageAlerts, normalizeThresholds, type UsageAlert } from './usage-alert.js';
export {
  assertPlanCatalog,
  findPlan,
  planAssignment,
  type PlanDefinition,
  type PlanAssignment,
} from './plan.js';
export {
  planDunning,
  dunningStateFromCharges,
  type DunningSchedule,
  type DunningInput,
  type DunningDecision,
  type DunningState,
} from './dunning.js';
export { assertHttpsUrl, assertPostgresTls } from './transport-security.js';
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
export {
  buildRetentionReport,
  type RetentionReport,
  type RetainedTenant,
  type RetentionReportOptions,
} from './retention-report.js';
export { redactSecrets, type TenantEvent } from './observability.js';
export {
  TRACEPARENT_HEADER,
  type TraceParent,
  isValidTraceId,
  isValidSpanId,
  parseTraceparent,
  formatTraceparent,
} from './trace.js';
export {
  normalizeAuditQuery,
  type AuditQueryInput,
  type NormalizedAuditQuery,
  type AuditQueryBounds,
} from './audit-query.js';
export {
  detectAuditAnomalies,
  type AnomalyThresholds,
  type AuditAnomaly,
} from './audit-anomaly.js';
export {
  detectCostAnomalies,
  type CostAnomalyThresholds,
  type CostAnomaly,
} from './cost-anomaly.js';
export {
  buildOperatorDigest,
  formatOperatorDigest,
  type DigestSeverity,
  type DigestCategory,
  type OperatorDigest,
  type OperatorDigestInput,
} from './operator-digest.js';
export {
  webhookSecretKey,
  subscriptionMatchesEvent,
  toWebhookSubscriptionSummary,
  type WebhookSubscriptionRecord,
  type WebhookSubscriptionSummary,
  type WebhookSubscriptionCreated,
} from './webhook-subscription.js';
export {
  signupTokenStatus,
  assertRedeemable,
  type SignupTokenRecord,
  type SignupTokenStatus,
} from './signup-token.js';
export {
  emailVerificationStatus,
  assertVerifiable,
  MAX_ATTEMPTS as EMAIL_VERIFICATION_MAX_ATTEMPTS,
  type EmailVerificationRecord,
  type EmailVerificationStatus,
} from './email-verification.js';
export {
  canRevealConnection,
  SIGNUP_REQUEST_STATUSES,
  type SignupRequestRecord,
  type SignupRequestStatus,
} from './signup-request.js';
export {
  buildErasureCertificate,
  type ErasureCertificate,
  type ErasureVerification,
  type ErasureSteps,
} from './erasure.js';
export {
  verifyErasureCertificate,
  erasureCertClaims,
  ERASURE_CERT_ALG,
  ERASURE_CERT_TYP,
  type SignedErasureCertificate,
} from './erasure-cert.js';
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
