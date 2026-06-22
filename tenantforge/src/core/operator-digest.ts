import type { AuditAnomaly } from './audit-anomaly.js';
import type { CostAnomaly } from './cost-anomaly.js';

/**
 * Operator alert digest — a pure roll-up that turns the separate control-plane detectors (audit
 * anomalies, cost anomalies, fleet migration drift, retention backlog, usage alerts) into ONE
 * operational-health summary with a single overall severity. The single pane an operator checks
 * (or alerts on) instead of running five scans (topic-logging-observability; std-mitre-attack
 * detection roll-up). Pure + deterministic — all I/O (gathering the inputs, sending the alert) lives
 * in the imperative shell, so this is exhaustively unit-testable.
 */

/** Operational severity, in ascending urgency. `ok` = nothing to report. */
export type DigestSeverity = 'ok' | 'info' | 'warning' | 'critical';

/** Ascending rank so the overall severity is the max across categories. */
const RANK: Record<DigestSeverity, number> = { ok: 0, info: 1, warning: 2, critical: 3 };

/** The detector inputs the digest summarizes (core-typed arrays + already-summarized scalars). */
export interface OperatorDigestInput {
  /** Emission instant (ISO-8601 UTC) — injected so the digest is deterministic/testable. */
  generatedAt: string;
  /** Audit-trail anomaly findings (error spikes / per-actor / per-tenant clusters). */
  auditAnomalies: readonly AuditAnomaly[];
  /** Cost/margin anomaly findings (unprofitable / unpriced / low-margin / high-cost). */
  costAnomalies: readonly CostAnomaly[];
  /** Fleet schema drift: target version + how many tenants are behind it. */
  drift: { target: string | null; pendingTenants: number };
  /** Retention backlog: tenants past their window (eligible for purge) vs still within it. */
  retention: { eligible: number; pending: number };
  /** Usage sweep: tenants that crossed an allowance threshold, and tenants that couldn't be metered. */
  usage: { alertedTenants: number; scanFailures: number };
}

/** One detector's contribution to the digest. */
export interface DigestCategory {
  /** Stable category key (e.g. `audit`, `cost`, `drift`, `retention`, `usage`). */
  category: string;
  /** This category's severity. */
  severity: DigestSeverity;
  /** Number of items behind the severity (0 when `ok`). */
  count: number;
  /** Short human-readable summary line (safe — counts only, no secrets/PII). */
  detail: string;
}

/** The assembled digest. */
export interface OperatorDigest {
  /** Emission instant (ISO-8601 UTC). */
  generatedAt: string;
  /** Overall severity = the most urgent category. */
  severity: DigestSeverity;
  /** Total non-`ok` items across all categories. */
  totalIssues: number;
  /** One-line summary (e.g. `warning: 3 issues across cost, drift`). */
  headline: string;
  /** Per-detector breakdown, most-urgent first. */
  categories: DigestCategory[];
}

/** The most urgent of two severities. */
function moreSevere(a: DigestSeverity, b: DigestSeverity): DigestSeverity {
  return RANK[a] >= RANK[b] ? a : b;
}

/** Plural-aware noun, e.g. `1 tenant` / `3 tenants`. */
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** `1 anomaly` / `3 anomalies` (the -y → -ies case `plural` doesn't handle). */
function anomalies(n: number): string {
  return `${n} ${n === 1 ? 'anomaly' : 'anomalies'}`;
}

function auditCategory(found: readonly AuditAnomaly[]): DigestCategory {
  const spike = found.some((a) => a.kind === 'error-spike');
  const severity: DigestSeverity = spike ? 'critical' : found.length > 0 ? 'warning' : 'ok';
  const detail =
    found.length === 0
      ? 'no audit anomalies'
      : `${anomalies(found.length)}${spike ? ' (incl. an error spike)' : ''}`;
  return { category: 'audit', severity, count: found.length, detail };
}

function costCategory(found: readonly CostAnomaly[]): DigestCategory {
  const unprofitable = found.some((a) => a.kind === 'unprofitable');
  const severity: DigestSeverity = unprofitable ? 'critical' : found.length > 0 ? 'warning' : 'ok';
  const detail =
    found.length === 0
      ? 'no cost anomalies'
      : `${anomalies(found.length)}${unprofitable ? ' (incl. unprofitable tenants)' : ''}`;
  return { category: 'cost', severity, count: found.length, detail };
}

function driftCategory(drift: OperatorDigestInput['drift']): DigestCategory {
  const severity: DigestSeverity = drift.pendingTenants > 0 ? 'warning' : 'ok';
  const target = drift.target ?? 'n/a';
  const detail =
    drift.pendingTenants > 0
      ? `${plural(drift.pendingTenants, 'tenant')} behind target ${target}`
      : `fleet at target ${target}`;
  return { category: 'drift', severity, count: drift.pendingTenants, detail };
}

function retentionCategory(retention: OperatorDigestInput['retention']): DigestCategory {
  const severity: DigestSeverity = retention.eligible > 0 ? 'warning' : 'ok';
  const detail =
    retention.eligible > 0
      ? `${plural(retention.eligible, 'tenant')} past retention, awaiting purge (${retention.pending} within window)`
      : `none past retention (${retention.pending} within window)`;
  return { category: 'retention', severity, count: retention.eligible, detail };
}

function usageCategory(usage: OperatorDigestInput['usage']): DigestCategory {
  // A metering failure is a warning (we're flying blind for that tenant); crossing an allowance
  // threshold is informational (expected operational signal, not a fault).
  const severity: DigestSeverity =
    usage.scanFailures > 0 ? 'warning' : usage.alertedTenants > 0 ? 'info' : 'ok';
  const parts: string[] = [];
  if (usage.alertedTenants > 0)
    parts.push(`${plural(usage.alertedTenants, 'tenant')} over allowance`);
  if (usage.scanFailures > 0) parts.push(`${plural(usage.scanFailures, 'metering failure')}`);
  return {
    category: 'usage',
    severity,
    count: usage.alertedTenants,
    detail: parts.length > 0 ? parts.join(', ') : 'usage within allowances',
  };
}

/**
 * Assemble the {@link OperatorDigest} from the detector inputs. Each category is classified, the
 * overall severity is the most urgent category, and categories are ordered most-urgent first
 * (stable by their fixed order within an equal severity).
 *
 * @param input - The summarized detector outputs.
 * @returns The operational-health digest.
 */
export function buildOperatorDigest(input: OperatorDigestInput): OperatorDigest {
  const categories: DigestCategory[] = [
    auditCategory(input.auditAnomalies),
    costCategory(input.costAnomalies),
    driftCategory(input.drift),
    retentionCategory(input.retention),
    usageCategory(input.usage),
  ];

  const severity = categories.reduce<DigestSeverity>((acc, c) => moreSevere(acc, c.severity), 'ok');
  const totalIssues = categories.reduce((sum, c) => sum + (c.severity === 'ok' ? 0 : c.count), 0);

  // Stable sort by descending severity rank; equal severities keep their declared order.
  const sorted = categories
    .map((c, index) => ({ c, index }))
    .sort((a, b) => RANK[b.c.severity] - RANK[a.c.severity] || a.index - b.index)
    .map((e) => e.c);

  const offenders = sorted.filter((c) => c.severity !== 'ok').map((c) => c.category);
  const headline =
    severity === 'ok'
      ? 'ok: all clear'
      : `${severity}: ${plural(totalIssues, 'issue')} across ${offenders.join(', ')}`;

  return { generatedAt: input.generatedAt, severity, totalIssues, headline, categories: sorted };
}

/**
 * Render the digest as a plain-text body for an operator notification / CLI output. Safe — counts
 * and category details only, no secrets or PII.
 *
 * @param digest - The assembled digest.
 * @returns A multi-line plain-text summary.
 */
export function formatOperatorDigest(digest: OperatorDigest): string {
  const lines = [
    `Operator digest — ${digest.headline}`,
    `Generated: ${digest.generatedAt}`,
    '',
    ...digest.categories.map((c) => `  [${c.severity}] ${c.category}: ${c.detail}`),
  ];
  return lines.join('\n');
}
