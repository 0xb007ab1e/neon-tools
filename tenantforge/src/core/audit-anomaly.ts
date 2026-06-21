import type { TenantEvent } from './observability.js';

/**
 * Thresholds for {@link detectAuditAnomalies}. Each is the count at/above which a finding is raised
 * over the window of events examined. The operator owns these (their risk appetite); Neon has no
 * notion of control-plane operations, so this detection is builder-side (std-mitre-attack /
 * topic-logging-observability: alert on error bursts + repeated failures).
 */
export interface AnomalyThresholds {
  /** Total `error`-outcome events in the window at/above which an `error-spike` is raised. */
  errorSpike?: number;
  /** Per-actor `error` count at/above which an `actor-errors` finding is raised (abuse / compromise). */
  perActorErrors?: number;
  /** Per-tenant `error` count at/above which a `tenant-errors` finding is raised (repeated failures). */
  perTenantErrors?: number;
}

/** One detected anomaly in the audit trail. */
export interface AuditAnomaly {
  /** What was detected. */
  kind: 'error-spike' | 'actor-errors' | 'tenant-errors';
  /** The actor id (`actor-errors`) or tenant id (`tenant-errors`); absent for `error-spike`. */
  subject?: string;
  /** The number of error events behind the finding. */
  count: number;
  /** Distinct event names involved (sorted), for triage. */
  events: string[];
}

const DEFAULTS: Required<AnomalyThresholds> = {
  errorSpike: 10,
  perActorErrors: 5,
  perTenantErrors: 5,
};

/** Distinct, sorted event names from a list of events. */
function eventNames(events: TenantEvent[]): string[] {
  return [...new Set(events.map((e) => e.event))].sort();
}

/** Group events by a key derived from each (skipping events with no key). */
function groupBy(
  events: TenantEvent[],
  key: (e: TenantEvent) => string | undefined,
): Map<string, TenantEvent[]> {
  const groups = new Map<string, TenantEvent[]>();
  for (const e of events) {
    const k = key(e);
    if (k === undefined) continue;
    const bucket = groups.get(k);
    if (bucket) bucket.push(e);
    else groups.set(k, [e]);
  }
  return groups;
}

/**
 * Detect anomalies in a window of (already-redacted) audit events: an overall **error spike**, and
 * **per-actor** / **per-tenant** error clusters. Pure and deterministic — findings come back in a
 * fixed order (error-spike, then actor-errors by subject, then tenant-errors by subject) so output
 * is stable. Only `error`-outcome events are considered.
 *
 * @param events - The window of audit events to examine (e.g. the most recent N).
 * @param thresholds - Optional thresholds (sensible defaults applied per field).
 * @returns The detected anomalies (empty when nothing crosses a threshold).
 */
export function detectAuditAnomalies(
  events: TenantEvent[],
  thresholds: AnomalyThresholds = {},
): AuditAnomaly[] {
  const t = {
    errorSpike: thresholds.errorSpike ?? DEFAULTS.errorSpike,
    perActorErrors: thresholds.perActorErrors ?? DEFAULTS.perActorErrors,
    perTenantErrors: thresholds.perTenantErrors ?? DEFAULTS.perTenantErrors,
  };
  const errors = events.filter((e) => e.outcome === 'error');
  const findings: AuditAnomaly[] = [];

  if (errors.length >= t.errorSpike) {
    findings.push({ kind: 'error-spike', count: errors.length, events: eventNames(errors) });
  }

  const byActor = groupBy(errors, (e) => e.actor?.id);
  for (const subject of [...byActor.keys()].sort()) {
    const group = byActor.get(subject)!;
    if (group.length >= t.perActorErrors) {
      findings.push({
        kind: 'actor-errors',
        subject,
        count: group.length,
        events: eventNames(group),
      });
    }
  }

  const byTenant = groupBy(errors, (e) => e.tenantId);
  for (const subject of [...byTenant.keys()].sort()) {
    const group = byTenant.get(subject)!;
    if (group.length >= t.perTenantErrors) {
      findings.push({
        kind: 'tenant-errors',
        subject,
        count: group.length,
        events: eventNames(group),
      });
    }
  }

  return findings;
}
