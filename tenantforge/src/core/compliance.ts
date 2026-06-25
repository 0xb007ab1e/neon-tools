import { regionJurisdiction } from './residency.js';
import { isValidRegion } from './regions.js';
import type { TenantRecord, TenantStatus } from './domain.js';
import type { TenantEvent } from './observability.js';

/** Statuses whose tenants are expected to have a provisioned Neon project. */
const PROVISIONED_STATUSES: ReadonlySet<TenantStatus> = new Set<TenantStatus>([
  'active',
  'suspended',
  'offboarding',
]);

/** A compact, redacted audit-trail entry included in the compliance report. */
export interface ComplianceAuditEntry {
  /** Event instant (ISO-8601 UTC). */
  at: string;
  /** Dotted event name. */
  event: string;
  /** Whether the operation succeeded. */
  outcome: 'ok' | 'error';
  /** The operator who performed the action (absent for scheduled sweeps). */
  actor?: { id: string; role: string };
  /** The tenant the event concerns (absent for fleet-level events). */
  tenantId?: string;
}

/** A point-in-time compliance attestation derived from the control-plane registry. */
export interface ComplianceReport {
  /** When the report was generated (ISO-8601 UTC). */
  generatedAt: string;
  /** Every tenant in the registry, counted by status. */
  inventory: { total: number; byStatus: Record<TenantStatus, number> };
  /**
   * Physical-isolation attestation: each live tenant has its own dedicated Neon project. A shared
   * project id across tenants is a cross-tenant isolation violation.
   */
  isolation: {
    compliant: boolean;
    /** Tenant ids whose status implies a project but `neonProjectId` is null. */
    missingProject: string[];
    /** Project ids backing more than one tenant (a violation), with the tenants sharing them. */
    sharedProjects: { neonProjectId: string; tenantIds: string[] }[];
  };
  /**
   * Data-residency attestation: each live tenant's region maps to a known jurisdiction and (when an
   * org allow-list is configured) is permitted by it.
   */
  residency: {
    compliant: boolean;
    /** The org region allow-list in force (empty = unrestricted). */
    allowedRegions: string[];
    /** Live tenants per residency jurisdiction; `unknown` = region with no jurisdiction mapping. */
    byJurisdiction: Record<string, number>;
    /** Tenants whose region is outside the allow-list or has no known jurisdiction. */
    violations: { tenantId: string; region: string; reason: string }[];
  };
  /**
   * Audit-trail evidence from the persisted audit log (present only when an audit store is wired):
   * **erasure history** (transitions to `deleted` — right-to-erasure evidence) and a **recent
   * excerpt** of control-plane activity. Both newest-first; omitted entirely when no store exists.
   */
  audit?: {
    /** Erasure (tenant deletion) events, newest-first. */
    erasures: ComplianceAuditEntry[];
    /** A recent excerpt of control-plane events, newest-first. */
    recent: ComplianceAuditEntry[];
  };
}

/** Options for {@link buildComplianceReport}. */
export interface ComplianceReportOptions {
  /** Org region allow-list (empty = unrestricted). */
  allowedRegions?: readonly string[];
  /** The generation instant (injected for determinism). */
  now: Date;
  /**
   * Audit-trail events fetched from the persisted store (already redacted). When provided, the
   * report includes an `audit` section; omitted = no audit store, no `audit` section.
   */
  audit?: {
    /** Erasure (tenant-deletion) events. */
    erasures: readonly TenantEvent[];
    /** A recent excerpt of control-plane events. */
    recent: readonly TenantEvent[];
  };
}

/** Map a full event to the compact, redacted entry the report exposes. */
function toAuditEntry(e: TenantEvent): ComplianceAuditEntry {
  return {
    at: e.at,
    event: e.event,
    outcome: e.outcome,
    ...(e.actor !== undefined ? { actor: { id: e.actor.id, role: e.actor.role } } : {}),
    ...(e.tenantId !== undefined ? { tenantId: e.tenantId } : {}),
  };
}

/**
 * Sort events newest-first and map to compact, **PII-minimized** entries (deterministic, hashable
 * output). Exported so the evidence bundle (ADR-0011 Phase 2) reuses the **same** redaction +
 * canonicalization as the compliance report — never a second, divergent projection.
 *
 * @param events - The (already-`redactSecrets`-passed) audit events to project.
 * @returns The compact entries, newest-first.
 */
export function auditEntries(events: readonly TenantEvent[]): ComplianceAuditEntry[] {
  return [...events].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).map(toAuditEntry);
}

/** The per-status tenant inventory of a report (a count of every lifecycle status + the total). */
export type ComplianceInventory = ComplianceReport['inventory'];
/** The physical-isolation attestation block of a report. */
export type ComplianceIsolation = ComplianceReport['isolation'];
/** The data-residency attestation block of a report. */
export type ComplianceResidency = ComplianceReport['residency'];

/**
 * Count a set of tenants by lifecycle status (an inventory) — pure. Extracted so the evidence bundle
 * (ADR-0011 Phase 2) computes a **per-tenant** or fleet inventory with the **same** logic the
 * compliance report uses (no duplication; DIP — `@rules/topic-architecture-patterns.md`).
 *
 * @param tenants - The tenant records to count.
 * @returns The total and per-status counts (every status key present, even at zero).
 */
export function inventoryByStatus(tenants: readonly TenantRecord[]): ComplianceInventory {
  const byStatus: Record<TenantStatus, number> = {
    provisioning: 0,
    active: 0,
    suspended: 0,
    offboarding: 0,
    deleted: 0,
  };
  for (const t of tenants) byStatus[t.status] += 1;
  return { total: tenants.length, byStatus };
}

/**
 * Build the **physical-isolation attestation** over a set of *live* tenants (deleted tenants have no
 * project, so the caller filters them out first) — pure. Flags a project that is expected-but-absent
 * (`missingProject`) or shared by more than one tenant (`sharedProjects`, a cross-tenant violation).
 * Arrays are sorted for a stable, hashable output. Extracted from {@link buildComplianceReport} so
 * the evidence bundle reuses the exact same attestation (ADR-0011 Phase 2).
 *
 * @param live - The live (non-`deleted`) tenants to attest.
 * @returns The isolation attestation block.
 */
export function buildIsolationAttestation(live: readonly TenantRecord[]): ComplianceIsolation {
  const missingProject = live
    .filter((t) => PROVISIONED_STATUSES.has(t.status) && t.neonProjectId === null)
    .map((t) => t.id)
    .sort();
  const byProject = new Map<string, string[]>();
  for (const t of live) {
    if (t.neonProjectId === null) continue;
    const ids = byProject.get(t.neonProjectId) ?? [];
    ids.push(t.id);
    byProject.set(t.neonProjectId, ids);
  }
  const sharedProjects = [...byProject.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([neonProjectId, tenantIds]) => ({ neonProjectId, tenantIds: [...tenantIds].sort() }))
    .sort((a, b) => a.neonProjectId.localeCompare(b.neonProjectId));
  return {
    compliant: missingProject.length === 0 && sharedProjects.length === 0,
    missingProject,
    sharedProjects,
  };
}

/**
 * Build the **data-residency attestation** over a set of *live* tenants — pure. Maps each tenant's
 * region to a jurisdiction, counts by jurisdiction, and flags tenants whose region is unknown or
 * outside the org allow-list. Violations are sorted for a stable, hashable output. Extracted from
 * {@link buildComplianceReport} so the evidence bundle reuses the exact same attestation (ADR-0011
 * Phase 2).
 *
 * @param live - The live (non-`deleted`) tenants to attest.
 * @param allowedRegions - The org region allow-list (empty = unrestricted).
 * @returns The residency attestation block.
 */
export function buildResidencyAttestation(
  live: readonly TenantRecord[],
  allowedRegions: readonly string[],
): ComplianceResidency {
  const byJurisdiction: Record<string, number> = {};
  const violations: { tenantId: string; region: string; reason: string }[] = [];
  for (const t of live) {
    const jurisdiction = isValidRegion(t.region) ? regionJurisdiction(t.region) : 'unknown';
    byJurisdiction[jurisdiction] = (byJurisdiction[jurisdiction] ?? 0) + 1;
    if (jurisdiction === 'unknown') {
      violations.push({
        tenantId: t.id,
        region: t.region,
        reason: 'no known residency jurisdiction',
      });
    } else if (allowedRegions.length > 0 && !allowedRegions.includes(t.region)) {
      violations.push({ tenantId: t.id, region: t.region, reason: 'region not in org allow-list' });
    }
  }
  violations.sort((a, b) => a.tenantId.localeCompare(b.tenantId));
  return {
    compliant: violations.length === 0,
    allowedRegions: [...allowedRegions],
    byJurisdiction,
    violations,
  };
}

/**
 * Build a point-in-time compliance report from the tenant registry — pure and deterministic
 * (master §2; topic-multi-tenancy). It attests **physical isolation** (one dedicated Neon project
 * per tenant) and **data residency** (region → jurisdiction, within the org allow-list) over the
 * **live** fleet (deleted tenants are inventoried but excluded from the attestations, since they
 * have no project). It emits *evidence* — queryable facts, not a legal certification.
 *
 * @param tenants - All tenant records from the registry.
 * @param options - Org allow-list and the generation instant.
 * @returns The compliance report (arrays sorted for a stable, hashable output).
 */
export function buildComplianceReport(
  tenants: readonly TenantRecord[],
  options: ComplianceReportOptions,
): ComplianceReport {
  const allowedRegions = [...(options.allowedRegions ?? [])];

  // Attestations cover the live fleet only (a deleted tenant's project is gone by design).
  const live = tenants.filter((t) => t.status !== 'deleted');

  return {
    generatedAt: options.now.toISOString(),
    inventory: inventoryByStatus(tenants),
    isolation: buildIsolationAttestation(live),
    residency: buildResidencyAttestation(live, allowedRegions),
    ...(options.audit !== undefined
      ? {
          audit: {
            erasures: auditEntries(options.audit.erasures),
            recent: auditEntries(options.audit.recent),
          },
        }
      : {}),
  };
}
