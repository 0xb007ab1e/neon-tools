import type { TenantEvent } from './observability.js';

/** Dunning policy: how many charge attempts to make, and how long to wait between them. */
export interface DunningSchedule {
  /** Max consecutive failed attempts before giving up retrying and escalating (suspend). */
  maxAttempts: number;
  /** Minimum hours to wait between retry attempts (backoff). */
  minHoursBetweenAttempts: number;
}

/** Inputs to {@link planDunning} for one past-due tenant. */
export interface DunningInput {
  /** Consecutive failed charge attempts since the last success (0 = not failing). */
  consecutiveFailures: number;
  /** Hours since the last charge attempt (for backoff). */
  hoursSinceLastAttempt: number;
  /** The dunning policy. */
  schedule: DunningSchedule;
}

/** The decided next dunning action for a tenant. */
export interface DunningDecision {
  /**
   * `retry` — attempt the charge again now; `wait` — within backoff or not failing, do nothing;
   * `suspend` — attempts exhausted, escalate (suspend the tenant, reversibly).
   */
  action: 'retry' | 'wait' | 'suspend';
  /** The attempt number a `retry` would make (== `consecutiveFailures`); 0 otherwise. */
  attempt: number;
}

/**
 * Decide the next dunning action for a past-due tenant — pure and deterministic (the decision behind
 * the retry sweep). Give up (escalate to `suspend`) once `maxAttempts` consecutive failures is
 * reached; otherwise honor the backoff window before retrying; do nothing when not failing.
 *
 * @param input - Consecutive failures, hours since the last attempt, and the schedule.
 * @returns The action + the attempt number a retry would make.
 * @throws Error if the schedule is invalid.
 */
export function planDunning(input: DunningInput): DunningDecision {
  const { maxAttempts, minHoursBetweenAttempts } = input.schedule;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`maxAttempts must be a positive integer, got ${maxAttempts}`);
  }
  if (!(minHoursBetweenAttempts >= 0)) {
    throw new Error(`minHoursBetweenAttempts must be >= 0, got ${minHoursBetweenAttempts}`);
  }

  if (input.consecutiveFailures <= 0) return { action: 'wait', attempt: 0 };
  if (input.consecutiveFailures >= maxAttempts) return { action: 'suspend', attempt: 0 };
  if (input.hoursSinceLastAttempt < minHoursBetweenAttempts) return { action: 'wait', attempt: 0 };
  return { action: 'retry', attempt: input.consecutiveFailures };
}

/** The derived dunning state for a tenant: how many charges have failed in a row, and how long ago. */
export interface DunningState {
  /** Consecutive failed charge attempts since the last success (0 = not failing). */
  consecutiveFailures: number;
  /** Hours since the most recent charge attempt; `Infinity` when there is no charge history. */
  hoursSinceLastAttempt: number;
}

const MS_PER_HOUR = 3_600_000;

/**
 * Derive a tenant's dunning state from its `tenant.charged` audit events — pure and deterministic.
 * Counts the run of failures from the most recent attempt backward, stopping at the first success
 * (a success resets the counter). Newest-first input is required (as the audit store returns).
 *
 * @param charges - The tenant's `tenant.charged` events, **newest-first**.
 * @param now - The current instant (injected so the result is testable).
 * @returns The consecutive-failure count and hours since the last attempt.
 */
export function dunningStateFromCharges(charges: readonly TenantEvent[], now: Date): DunningState {
  let consecutiveFailures = 0;
  for (const charge of charges) {
    if (charge.outcome !== 'error') break;
    consecutiveFailures += 1;
  }
  const latest = charges[0];
  if (latest === undefined) return { consecutiveFailures, hoursSinceLastAttempt: Infinity };
  const lastMs = Date.parse(latest.at);
  const hoursSinceLastAttempt = Number.isNaN(lastMs)
    ? Infinity
    : (now.getTime() - lastMs) / MS_PER_HOUR;
  return { consecutiveFailures, hoursSinceLastAttempt };
}
