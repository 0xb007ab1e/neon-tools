import type { TenantRecord } from './domain.js';

/** The subset of a tenant record needed to decide purge-eligibility. */
export type RetainableTenant = Pick<TenantRecord, 'status' | 'updatedAt'>;

/**
 * Compute the retention cutoff: archived tenants whose offboarding predates this instant are
 * eligible for purge. Pure (the clock is passed in — inject it, never call `now()` here, so this
 * is deterministic and testable — topic-numeric-correctness).
 *
 * @param now - The current instant.
 * @param retentionDays - How long an archived (offboarding) tenant is retained before purge.
 * @returns The cutoff instant; tenants offboarded at or before it are purgeable.
 * @throws Error if `retentionDays` is negative.
 */
export function retentionCutoff(now: Date, retentionDays: number): Date {
  if (retentionDays < 0) {
    throw new Error(`retentionDays must be >= 0, got ${retentionDays}`);
  }
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}

/**
 * Whether an archived tenant is past its retention window and may be purged.
 *
 * Only `offboarding` (archived) tenants qualify — a tenant's `updatedAt` is the instant it was
 * archived (it receives no further writes until purge). Anything else (active/suspended/deleted) is
 * never swept (fail closed).
 *
 * @param tenant - The tenant's status and last-updated instant.
 * @param cutoff - The retention cutoff (see {@link retentionCutoff}).
 * @returns True if the tenant is offboarding and was archived at or before the cutoff.
 */
export function isPurgeable(tenant: RetainableTenant, cutoff: Date): boolean {
  return tenant.status === 'offboarding' && tenant.updatedAt.getTime() <= cutoff.getTime();
}
