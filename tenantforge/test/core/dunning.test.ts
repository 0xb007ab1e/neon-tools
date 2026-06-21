import { describe, expect, it } from 'vitest';
import { planDunning, dunningStateFromCharges } from '../../src/core/dunning.js';
import type { TenantEvent } from '../../src/core/observability.js';

const schedule = { maxAttempts: 4, minHoursBetweenAttempts: 24 };

/** A `tenant.charged` audit event with the given outcome at the given instant. */
function charge(outcome: 'ok' | 'error', at: string): TenantEvent {
  return { event: 'tenant.charged', at, outcome };
}

describe('planDunning', () => {
  it('waits when not failing (no consecutive failures)', () => {
    expect(planDunning({ consecutiveFailures: 0, hoursSinceLastAttempt: 999, schedule })).toEqual({
      action: 'wait',
      attempt: 0,
    });
  });

  it('suspends once failures reach maxAttempts (retries exhausted)', () => {
    expect(planDunning({ consecutiveFailures: 4, hoursSinceLastAttempt: 999, schedule })).toEqual({
      action: 'suspend',
      attempt: 0,
    });
  });

  it('waits within the backoff window even when failing', () => {
    expect(planDunning({ consecutiveFailures: 2, hoursSinceLastAttempt: 1, schedule })).toEqual({
      action: 'wait',
      attempt: 0,
    });
  });

  it('retries (with the attempt number) once the backoff window has elapsed', () => {
    expect(planDunning({ consecutiveFailures: 2, hoursSinceLastAttempt: 30, schedule })).toEqual({
      action: 'retry',
      attempt: 2,
    });
  });

  it('retries exactly at the backoff boundary (>= is satisfied)', () => {
    expect(planDunning({ consecutiveFailures: 1, hoursSinceLastAttempt: 24, schedule })).toEqual({
      action: 'retry',
      attempt: 1,
    });
  });

  it('rejects a non-positive / non-integer maxAttempts', () => {
    expect(() =>
      planDunning({
        consecutiveFailures: 1,
        hoursSinceLastAttempt: 0,
        schedule: { maxAttempts: 0, minHoursBetweenAttempts: 1 },
      }),
    ).toThrow(/maxAttempts must be a positive integer/);
    expect(() =>
      planDunning({
        consecutiveFailures: 1,
        hoursSinceLastAttempt: 0,
        schedule: { maxAttempts: 1.5, minHoursBetweenAttempts: 1 },
      }),
    ).toThrow(/maxAttempts/);
  });

  it('rejects a negative minHoursBetweenAttempts', () => {
    expect(() =>
      planDunning({
        consecutiveFailures: 1,
        hoursSinceLastAttempt: 0,
        schedule: { maxAttempts: 3, minHoursBetweenAttempts: -1 },
      }),
    ).toThrow(/minHoursBetweenAttempts must be >= 0/);
  });
});

describe('dunningStateFromCharges', () => {
  const now = new Date('2026-06-21T12:00:00.000Z');

  it('counts the run of failures from newest backward, stopping at the first success', () => {
    const charges: TenantEvent[] = [
      charge('error', '2026-06-21T06:00:00.000Z'),
      charge('error', '2026-06-20T06:00:00.000Z'),
      charge('ok', '2026-06-19T06:00:00.000Z'),
      charge('error', '2026-06-18T06:00:00.000Z'),
    ];
    const state = dunningStateFromCharges(charges, now);
    expect(state.consecutiveFailures).toBe(2);
    expect(state.hoursSinceLastAttempt).toBe(6);
  });

  it('reports zero failures + Infinity backoff when there is no charge history', () => {
    expect(dunningStateFromCharges([], now)).toEqual({
      consecutiveFailures: 0,
      hoursSinceLastAttempt: Infinity,
    });
  });

  it('resets to zero when the most recent charge succeeded', () => {
    const state = dunningStateFromCharges([charge('ok', '2026-06-21T11:00:00.000Z')], now);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.hoursSinceLastAttempt).toBe(1);
  });

  it('treats an unparseable latest timestamp as Infinity (never blocks a retry on bad data)', () => {
    const state = dunningStateFromCharges([charge('error', 'not-a-date')], now);
    expect(state.consecutiveFailures).toBe(1);
    expect(state.hoursSinceLastAttempt).toBe(Infinity);
  });
});
