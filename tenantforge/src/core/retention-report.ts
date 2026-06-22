import type { TenantRecord } from './domain.js';
import { retentionCutoff, isPurgeable } from './retention.js';

/** The subset of a tenant needed for the retention report. */
export type RetainableReportTenant = Pick<TenantRecord, 'id' | 'slug' | 'status' | 'updatedAt'>;

/** Options for {@link buildRetentionReport}. */
export interface RetentionReportOptions {
  /** The current instant (injected for determinism). */
  now: Date;
  /** Retention window (days) an archived tenant is kept before purge. */
  retentionDays: number;
}

/** One archived (offboarding) tenant's retention status. */
export interface RetainedTenant {
  /** The tenant id. */
  tenantId: string;
  /** The tenant slug. */
  slug: string;
  /** When the tenant was archived (ISO-8601 UTC) — its `updatedAt` at offboard. */
  archivedAt: string;
  /** When it becomes eligible for purge (ISO-8601 UTC) — `archivedAt + retentionDays`. */
  purgeEligibleAt: string;
  /** Whether it is already past its retention window (purgeable now). */
  eligible: boolean;
}

/** A retention report over the archived (offboarding) tenants. */
export interface RetentionReport {
  /** When the report was generated (ISO-8601 UTC). */
  generatedAt: string;
  /** The retention window (days) the report was computed with. */
  retentionDays: number;
  /** Count already eligible for purge. */
  eligible: number;
  /** Count still within their retention window. */
  pending: number;
  /** Per-tenant rows (eligible first, then soonest-eligible; ties by id). */
  tenants: RetainedTenant[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Build a read-only **retention report** — which archived (offboarding) tenants are scheduled for
 * purge and when. Pure and deterministic (the clock is injected). Only `offboarding` tenants are
 * included (others are never purged — fail closed); eligibility reuses {@link isPurgeable} so it
 * matches the purge sweep exactly. The operator's retention policy — Neon has no notion of it.
 *
 * @param tenants - Tenants to consider (non-offboarding ones are filtered out).
 * @param options - The instant + retention window (days).
 * @returns The retention report.
 * @throws Error if `retentionDays` is negative (via {@link retentionCutoff}).
 */
export function buildRetentionReport(
  tenants: RetainableReportTenant[],
  options: RetentionReportOptions,
): RetentionReport {
  const cutoff = retentionCutoff(options.now, options.retentionDays); // throws on negative days
  const rows: RetainedTenant[] = tenants
    .filter((t) => t.status === 'offboarding')
    .map((t) => ({
      tenantId: t.id,
      slug: t.slug,
      archivedAt: t.updatedAt.toISOString(),
      purgeEligibleAt: new Date(
        t.updatedAt.getTime() + options.retentionDays * DAY_MS,
      ).toISOString(),
      eligible: isPurgeable(t, cutoff),
    }))
    .sort(
      (a, b) =>
        Number(b.eligible) - Number(a.eligible) ||
        (a.purgeEligibleAt < b.purgeEligibleAt
          ? -1
          : a.purgeEligibleAt > b.purgeEligibleAt
            ? 1
            : 0) ||
        a.tenantId.localeCompare(b.tenantId),
    );
  const eligible = rows.filter((r) => r.eligible).length;
  return {
    generatedAt: options.now.toISOString(),
    retentionDays: options.retentionDays,
    eligible,
    pending: rows.length - eligible,
    tenants: rows,
  };
}
