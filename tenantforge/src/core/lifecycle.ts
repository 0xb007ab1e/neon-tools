import type { TenantStatus } from './domain.js';

/**
 * Allowed tenant-status transitions (a finite state machine). Modeling the lifecycle explicitly —
 * rather than as scattered boolean flags — makes invalid transitions unrepresentable and centralizes
 * the rules in one place (topic-state-management).
 *
 * ```text
 * provisioning ──► active ──► suspended ──► active
 *      │             │            │
 *      ▼             ▼            ▼
 *   deleted     offboarding ──► deleted
 * ```
 */
const TRANSITIONS: Readonly<Record<TenantStatus, readonly TenantStatus[]>> = {
  // From `provisioning`: succeed to active, or tear down a failed/aborted provision.
  provisioning: ['active', 'deleted'],
  active: ['suspended', 'offboarding'],
  suspended: ['active', 'offboarding'],
  offboarding: ['deleted'],
  // Terminal.
  deleted: [],
};

/**
 * Whether a tenant status is terminal (no outgoing transitions).
 *
 * @param status - The status to test.
 * @returns True if no transition leaves `status`.
 */
export function isTerminal(status: TenantStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/**
 * Whether a tenant may move from one status to another.
 *
 * @param from - The current status.
 * @param to - The proposed next status.
 * @returns True if the transition is allowed.
 */
export function canTransition(from: TenantStatus, to: TenantStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Assert that a tenant-status transition is allowed, throwing if not.
 *
 * @param from - The current status.
 * @param to - The proposed next status.
 * @throws Error if the transition is not permitted by the lifecycle state machine.
 */
export function assertTransition(from: TenantStatus, to: TenantStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal tenant status transition: ${from} → ${to}`);
  }
}
