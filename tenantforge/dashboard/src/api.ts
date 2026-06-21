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

/** A fleet invoice run (mirrors the server's FleetInvoiceReport). */
export interface FleetInvoiceReport {
  generatedAt: string;
  invoices: { tenantId: string; currency: string; totalUsd: number }[];
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
