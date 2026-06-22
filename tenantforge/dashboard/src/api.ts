/** The compliance report shape returned by GET /dashboard/api/compliance (mirrors core ComplianceReport). */
export interface ComplianceReport {
  generatedAt: string;
  inventory: { total: number; byStatus: Record<string, number> };
  isolation: {
    compliant: boolean;
    missingProject: string[];
    sharedProjects: { neonProjectId: string; tenantIds: string[] }[];
  };
  residency: {
    compliant: boolean;
    allowedRegions: string[];
    byJurisdiction: Record<string, number>;
    violations: { tenantId: string; region: string; reason: string }[];
  };
  /** Present only when a persisted audit store is wired (erasure history + recent excerpt). */
  audit?: {
    erasures: AuditEntry[];
    recent: AuditEntry[];
  };
}

/** A compact audit-trail entry (mirrors core ComplianceAuditEntry). */
export interface AuditEntry {
  at: string;
  event: string;
  outcome: 'ok' | 'error';
  actor?: { id: string; role: string };
  tenantId?: string;
}

/** The authenticated operator. */
export interface Session {
  id: string;
  role: string;
}

const BASE = '/dashboard/api';

/** Current session, or null when not authenticated. */
export async function fetchSession(): Promise<Session | null> {
  const res = await fetch(`${BASE}/session`, { credentials: 'include' });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error('Could not check session');
  return (await res.json()) as Session;
}

/** Exchange an operator token for a session cookie. Throws on an invalid token. */
export async function login(token: string): Promise<Session> {
  const res = await fetch(`${BASE}/session`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (res.status === 401) throw new Error('Invalid operator token');
  if (!res.ok) throw new Error('Login failed');
  return (await res.json()) as Session;
}

/** Clear the session. */
export async function logout(): Promise<void> {
  await fetch(`${BASE}/session`, { method: 'DELETE', credentials: 'include' });
}

/** Load the compliance report panel data. */
export async function fetchCompliance(): Promise<{ report: ComplianceReport; digest: string }> {
  const res = await fetch(`${BASE}/compliance`, { credentials: 'include' });
  if (!res.ok) throw new Error('Could not load the compliance report');
  return (await res.json()) as { report: ComplianceReport; digest: string };
}

/** Fleet schema-version drift summary (subset of the server's FleetDriftReport). */
export interface DriftReport {
  latest: string | null;
  totalVersions: number;
  summary: { total: number; atLatest: number; drifted: number; withFailures: number };
}

/** Per-tenant cost/margin report (mirrors core CostReport). */
export interface CostReport {
  generatedAt: string;
  rows: {
    tenantId: string;
    costUsd: number;
    priceUsd: number | null;
    marginUsd: number | null;
    unprofitable: boolean;
  }[];
  unmetered: string[];
  totals: {
    tenants: number;
    costUsd: number;
    priceUsd: number;
    marginUsd: number;
    unprofitable: number;
    unpriced: number;
  };
}

/** Load the fleet drift panel data. */
export async function fetchDrift(): Promise<DriftReport> {
  const res = await fetch(`${BASE}/drift`, { credentials: 'include' });
  if (!res.ok) throw new Error('Could not load fleet drift');
  return (await res.json()) as DriftReport;
}

/** Load the cost/margin panel data. */
export async function fetchCost(): Promise<CostReport> {
  const res = await fetch(`${BASE}/cost`, { credentials: 'include' });
  if (!res.ok) throw new Error('Could not load the cost report');
  return (await res.json()) as CostReport;
}

/** One detected cost/margin anomaly. */
export interface CostAnomalyEntry {
  kind: 'unprofitable' | 'unpriced' | 'low-margin' | 'high-cost';
  tenantId: string;
  costUsd: number;
  priceUsd: number | null;
  marginUsd: number | null;
}

/** Load cost/margin anomalies for the current month (read-only; default thresholds). */
export async function fetchCostAnomalies(): Promise<CostAnomalyEntry[]> {
  const res = await fetch(`${BASE}/cost-anomalies`, { credentials: 'include' });
  if (!res.ok) throw new Error('Could not load cost anomalies');
  return ((await res.json()) as { anomalies: CostAnomalyEntry[] }).anomalies;
}

/** One billed line on an invoice. */
export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unit: string;
  amountUsd: number;
}

/** A fleet invoice run (mirrors the server's FleetInvoiceReport). */
export interface FleetInvoiceReport {
  generatedAt: string;
  invoices: {
    tenantId: string;
    currency: string;
    totalUsd: number;
    lineItems: InvoiceLineItem[];
  }[];
  unmetered: string[];
}

/** Load the fleet invoices panel data (current month). */
export async function fetchInvoices(): Promise<FleetInvoiceReport> {
  const res = await fetch(`${BASE}/invoices`, { credentials: 'include' });
  if (!res.ok) throw new Error('Could not load invoices');
  return (await res.json()) as FleetInvoiceReport;
}

/** A fleet reconcile plan (mirrors core FleetReconcilePlan; read-only preview). */
export interface ReconcilePlan {
  target: string | null;
  perTenant: { tenantId: string; missing: string[] }[];
  pendingTenants: string[];
  upToDate: string[];
  totalMissing: number;
}

/** Load the fleet reconcile plan (read-only preview — applies nothing). */
export async function fetchReconcilePlan(): Promise<ReconcilePlan> {
  const res = await fetch(`${BASE}/reconcile`, { credentials: 'include' });
  if (!res.ok) throw new Error('Could not load the reconcile plan');
  return (await res.json()) as ReconcilePlan;
}

/** One reconcile-history entry (a persisted `fleet.reconcile` audit event). */
export interface ReconcileHistoryEntry {
  at: string;
  outcome: 'ok' | 'error';
  actor?: { id: string; role: string };
  context?: { target?: string | null; reconciled?: number; partial?: number };
}

/** Load recent reconcile history from the persisted audit trail (empty without an audit store). */
export async function fetchReconcileHistory(): Promise<ReconcileHistoryEntry[]> {
  const res = await fetch(`${BASE}/reconcile-history`, { credentials: 'include' });
  if (!res.ok) throw new Error('Could not load reconcile history');
  return ((await res.json()) as { history: ReconcileHistoryEntry[] }).history;
}

/** Whether reconcile can be executed here (a SQL catalog is wired) and whether this user may. */
export interface ReconcileCapabilities {
  executable: boolean;
  mayExecute: boolean;
}

/** Load reconcile execution capabilities. */
export async function fetchReconcileCapabilities(): Promise<ReconcileCapabilities> {
  const res = await fetch(`${BASE}/reconcile/capabilities`, { credentials: 'include' });
  if (!res.ok) throw new Error('Could not load reconcile capabilities');
  return (await res.json()) as ReconcileCapabilities;
}

/** Result summary of executing a reconcile (subset of the server's FleetReconcileReport). */
export interface ReconcileResult {
  target: string | null;
  reconciled: string[];
  partial: { tenantId: string }[];
  canaryAborted?: boolean;
}

/** Execute a fleet reconcile (mutating; requires tenant:provision). Throws on a non-2xx response. */
export async function runReconcile(): Promise<ReconcileResult> {
  const res = await fetch(`${BASE}/reconcile`, { method: 'POST', credentials: 'include' });
  if (!res.ok) throw new Error(res.status === 403 ? 'Not permitted' : 'Reconcile failed');
  return (await res.json()) as ReconcileResult;
}

/** One charge-history entry (a persisted `tenant.charged` audit event). */
export interface ChargeHistoryEntry {
  at: string;
  outcome: 'ok' | 'error';
  tenantId?: string;
  context?: {
    provider?: string;
    chargeId?: string;
    amountMinor?: number;
    currency?: string;
    status?: string;
  };
}

/** Load recent charge history (read-only; empty without an audit store). */
export async function fetchCharges(): Promise<ChargeHistoryEntry[]> {
  const res = await fetch(`${BASE}/charges`, { credentials: 'include' });
  if (!res.ok) throw new Error('Could not load charges');
  return ((await res.json()) as { charges: ChargeHistoryEntry[] }).charges;
}

/** One inbound payment-webhook event (a persisted `payment.webhook` audit event). */
export interface PaymentEventEntry {
  at: string;
  outcome: 'ok' | 'error';
  tenantId?: string;
  context?: {
    type?: string;
    rawType?: string;
    chargeId?: string;
    amountMinor?: number;
    currency?: string;
  };
}

/** Load recent inbound payment-webhook events (read-only; empty without an audit store). */
export async function fetchPaymentEvents(): Promise<PaymentEventEntry[]> {
  const res = await fetch(`${BASE}/payment-events`, { credentials: 'include' });
  if (!res.ok) throw new Error('Could not load payment events');
  return ((await res.json()) as { events: PaymentEventEntry[] }).events;
}

/** One dunning-history entry (a persisted `tenant.dunning` audit event). */
export interface DunningHistoryEntry {
  at: string;
  outcome: 'ok' | 'error';
  tenantId?: string;
  context?: {
    action?: string;
    attempt?: number;
    failures?: number;
    status?: string;
  };
}

/** Load recent dunning history (read-only; empty without an audit store). */
export async function fetchDunning(): Promise<DunningHistoryEntry[]> {
  const res = await fetch(`${BASE}/dunning`, { credentials: 'include' });
  if (!res.ok) throw new Error('Could not load dunning history');
  return ((await res.json()) as { events: DunningHistoryEntry[] }).events;
}

/** One billing-run entry (a persisted `billing.run` roll-up audit event). */
export interface BillingRunEntry {
  at: string;
  outcome: 'ok' | 'error';
  context?: {
    charged?: number;
    chargeFailed?: number;
    retried?: number;
    suspended?: number;
    dunningFailed?: number;
  };
}

/** Load recent billing-run history (read-only; empty without an audit store). */
export async function fetchBillingRuns(): Promise<BillingRunEntry[]> {
  const res = await fetch(`${BASE}/billing-runs`, { credentials: 'include' });
  if (!res.ok) throw new Error('Could not load billing runs');
  return ((await res.json()) as { runs: BillingRunEntry[] }).runs;
}

/** One refund entry (a persisted `tenant.refunded` audit event). */
export interface RefundEntry {
  at: string;
  outcome: 'ok' | 'error';
  tenantId?: string;
  context?: {
    refundId?: string;
    chargeId?: string;
    amountMinor?: number;
    currency?: string;
    status?: string;
    reason?: string;
  };
}

/** Load recent refund history (read-only; empty without an audit store). */
export async function fetchRefunds(): Promise<RefundEntry[]> {
  const res = await fetch(`${BASE}/refunds`, { credentials: 'include' });
  if (!res.ok) throw new Error('Could not load refunds');
  return ((await res.json()) as { refunds: RefundEntry[] }).refunds;
}

/** One notification entry (a persisted `tenant.notified` billing-receipt audit event). */
export interface NotificationEntry {
  at: string;
  outcome: 'ok' | 'error';
  tenantId?: string;
  context?: {
    provider?: string;
    kind?: string;
    reference?: string;
    status?: string;
  };
}

/** Load recent billing-receipt notifications (read-only; empty without an audit store). */
export async function fetchNotifications(): Promise<NotificationEntry[]> {
  const res = await fetch(`${BASE}/notifications`, { credentials: 'include' });
  if (!res.ok) throw new Error('Could not load notifications');
  return ((await res.json()) as { notifications: NotificationEntry[] }).notifications;
}

/** One plan-change entry (a persisted `tenant.plan_changed` audit event). */
export interface PlanChangeEntry {
  at: string;
  outcome: 'ok' | 'error';
  tenantId?: string;
  context?: {
    oldPriceUsd?: number;
    newPriceUsd?: number;
    proratedDeltaMinor?: number;
    settlement?: string;
  };
}

/** Load recent plan-change history (read-only; empty without an audit store). */
export async function fetchPlanChanges(): Promise<PlanChangeEntry[]> {
  const res = await fetch(`${BASE}/plan-changes`, { credentials: 'include' });
  if (!res.ok) throw new Error('Could not load plan changes');
  return ((await res.json()) as { planChanges: PlanChangeEntry[] }).planChanges;
}

/** A retention report (mirrors the server's RetentionReport). */
export interface RetentionReport {
  generatedAt: string;
  retentionDays: number;
  eligible: number;
  pending: number;
  tenants: {
    tenantId: string;
    slug: string;
    archivedAt: string;
    purgeEligibleAt: string;
    eligible: boolean;
  }[];
}

/** Load the retention report (read-only; archived tenants scheduled for purge). */
export async function fetchRetention(): Promise<RetentionReport> {
  const res = await fetch(`${BASE}/retention`, { credentials: 'include' });
  if (!res.ok) throw new Error('Could not load the retention report');
  return (await res.json()) as RetentionReport;
}

/** One data-export entry (a persisted `tenant.exported` audit event). */
export interface ExportEntry {
  at: string;
  outcome: 'ok' | 'error';
  tenantId?: string;
  context?: { location?: string; bytes?: number };
}

/** Load recent data-export history (read-only; empty without an audit store). */
export async function fetchExports(): Promise<ExportEntry[]> {
  const res = await fetch(`${BASE}/exports`, { credentials: 'include' });
  if (!res.ok) throw new Error('Could not load data exports');
  return ((await res.json()) as { exports: ExportEntry[] }).exports;
}

/** One credit-grant entry (a persisted `tenant.credit_granted` audit event). */
export interface CreditGrantEntry {
  at: string;
  outcome: 'ok' | 'error';
  tenantId?: string;
  context?: { amountMinor?: number; currency?: string; reason?: string };
}

/** Load recent credit-grant history (read-only; empty without an audit store). */
export async function fetchCreditGrants(): Promise<CreditGrantEntry[]> {
  const res = await fetch(`${BASE}/credit-grants`, { credentials: 'include' });
  if (!res.ok) throw new Error('Could not load credit grants');
  return ((await res.json()) as { creditGrants: CreditGrantEntry[] }).creditGrants;
}

/** One usage-alert entry (a persisted `tenant.usage_alert` audit event). */
export interface UsageAlertEntry {
  at: string;
  outcome: 'ok' | 'error';
  tenantId?: string;
  context?: {
    alerts?: { metric: string; usedFraction: number; thresholdCrossed: number }[];
  };
}

/** Load recent usage-alert history (read-only; empty without an audit store). */
export async function fetchUsageAlerts(): Promise<UsageAlertEntry[]> {
  const res = await fetch(`${BASE}/usage-alerts`, { credentials: 'include' });
  if (!res.ok) throw new Error('Could not load usage alerts');
  return ((await res.json()) as { usageAlerts: UsageAlertEntry[] }).usageAlerts;
}

/** One plan in the operator catalog. */
export interface PlanEntry {
  id: string;
  name?: string;
  priceUsd?: number;
  includedUsage?: Record<string, number>;
}

/** Load the operator plan catalog (read-only; empty when none configured). */
export async function fetchPlans(): Promise<PlanEntry[]> {
  const res = await fetch(`${BASE}/plans`, { credentials: 'include' });
  if (!res.ok) throw new Error('Could not load plans');
  return ((await res.json()) as { plans: PlanEntry[] }).plans;
}

/** One signup-token summary (status only — never the token or its hash). */
export interface SignupTokenEntry {
  slug: string;
  status: 'pending' | 'redeemed' | 'expired';
  region?: string;
  planId?: string;
  expiresAt: string;
  createdAt: string;
  redeemedAt?: string;
  redeemedTenantId?: string;
}

/** Load recent signup tokens (read-only; empty when no store is wired). */
export async function fetchSignupTokens(): Promise<SignupTokenEntry[]> {
  const res = await fetch(`${BASE}/signup-tokens`, { credentials: 'include' });
  if (!res.ok) throw new Error('Could not load signup tokens');
  return ((await res.json()) as { signupTokens: SignupTokenEntry[] }).signupTokens;
}

/** One invoice-delivery entry (a persisted `tenant.invoiced` audit event). */
export interface InvoiceSentEntry {
  at: string;
  outcome: 'ok' | 'error';
  tenantId?: string;
  context?: { totalUsd?: number; status?: string; periodStart?: string; periodEnd?: string };
}

/** Load recent invoice-delivery history (read-only; empty without an audit store). */
export async function fetchInvoicesSent(): Promise<InvoiceSentEntry[]> {
  const res = await fetch(`${BASE}/invoices-sent`, { credentials: 'include' });
  if (!res.ok) throw new Error('Could not load invoice deliveries');
  return ((await res.json()) as { invoicesSent: InvoiceSentEntry[] }).invoicesSent;
}

/** One audit-trail event (who-did-what-when; already redacted). */
export interface AuditEventEntry {
  at: string;
  event: string;
  outcome: 'ok' | 'error';
  tenantId?: string;
  actor?: { id: string; role: string };
}

/** Load the recent control-plane audit trail (read-only; empty without an audit store). */
export async function fetchAudit(): Promise<AuditEventEntry[]> {
  const res = await fetch(`${BASE}/audit`, { credentials: 'include' });
  if (!res.ok) throw new Error('Could not load audit trail');
  return ((await res.json()) as { events: AuditEventEntry[] }).events;
}

/** One detected audit anomaly. */
export interface AuditAnomalyEntry {
  kind: 'error-spike' | 'actor-errors' | 'tenant-errors';
  subject?: string;
  count: number;
  events: string[];
}

/** Load audit anomalies over the recent window (read-only; empty without an audit store). */
export async function fetchAuditAnomalies(): Promise<AuditAnomalyEntry[]> {
  const res = await fetch(`${BASE}/audit-anomalies`, { credentials: 'include' });
  if (!res.ok) throw new Error('Could not load audit anomalies');
  return ((await res.json()) as { anomalies: AuditAnomalyEntry[] }).anomalies;
}
