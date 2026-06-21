import { describe, expect, it } from 'vitest';
import {
  invoiceChargeAmount,
  chargeIdempotencyKey,
  assertRefundAmount,
  refundIdempotencyKey,
  prorateRefundMinor,
} from '../../src/core/billing.js';
import type { Invoice } from '../../src/core/invoice.js';

const invoice = (over: Partial<Invoice> = {}): Invoice => ({
  tenantId: 't1',
  periodStart: '2026-06-01T00:00:00.000Z',
  periodEnd: '2026-07-01T00:00:00.000Z',
  currency: 'USD',
  generatedAt: '2026-07-01T00:00:00.000Z',
  lineItems: [],
  totalUsd: 12.34,
  ...over,
});

describe('invoiceChargeAmount', () => {
  it('converts dollars to integer minor units and lowercases the currency', () => {
    expect(invoiceChargeAmount(invoice({ totalUsd: 12.34, currency: 'USD' }))).toEqual({
      amountMinor: 1234,
      currency: 'usd',
    });
  });

  it('rounds at cents (no float drift)', () => {
    expect(invoiceChargeAmount(invoice({ totalUsd: 0.1 + 0.2 })).amountMinor).toBe(30);
  });

  it('fails closed on a zero, negative, or non-finite total', () => {
    expect(() => invoiceChargeAmount(invoice({ totalUsd: 0 }))).toThrow(/no positive amount/);
    expect(() => invoiceChargeAmount(invoice({ totalUsd: -5 }))).toThrow(/no positive amount/);
    expect(() => invoiceChargeAmount(invoice({ totalUsd: Number.NaN }))).toThrow(
      /no positive amount/,
    );
  });
});

describe('chargeIdempotencyKey', () => {
  it('is deterministic and encodes tenant + period + amount', () => {
    const key = chargeIdempotencyKey(invoice());
    expect(key).toBe(
      'tenantforge:charge:t1:2026-06-01T00:00:00.000Z..2026-07-01T00:00:00.000Z:1234usd',
    );
    expect(chargeIdempotencyKey(invoice())).toBe(key); // stable
  });

  it('changes when the amount changes (a genuinely different charge)', () => {
    expect(chargeIdempotencyKey(invoice({ totalUsd: 12.34 }))).not.toBe(
      chargeIdempotencyKey(invoice({ totalUsd: 99.99 })),
    );
  });

  it('propagates the zero-amount guard', () => {
    expect(() => chargeIdempotencyKey(invoice({ totalUsd: 0 }))).toThrow(/no positive amount/);
  });

  it('attempt 0 (or omitted) keeps the stable base key; a retry attempt yields a distinct key', () => {
    const base = chargeIdempotencyKey(invoice());
    expect(chargeIdempotencyKey(invoice(), 0)).toBe(base); // explicit 0 == omitted
    const retry1 = chargeIdempotencyKey(invoice(), 1);
    const retry2 = chargeIdempotencyKey(invoice(), 2);
    expect(retry1).toBe(`${base}:retry-1`);
    expect(retry2).toBe(`${base}:retry-2`);
    expect(new Set([base, retry1, retry2]).size).toBe(3); // all distinct — no PSP replay
  });
});

describe('assertRefundAmount', () => {
  it('accepts a full refund (undefined amount)', () => {
    expect(() => assertRefundAmount(undefined)).not.toThrow();
    expect(() => assertRefundAmount(undefined, 1000)).not.toThrow();
  });

  it('accepts a positive partial amount within the original charge', () => {
    expect(() => assertRefundAmount(500, 1000)).not.toThrow();
    expect(() => assertRefundAmount(1000, 1000)).not.toThrow(); // exactly the original
    expect(() => assertRefundAmount(500)).not.toThrow(); // original unknown → only positivity checked
  });

  it('rejects a non-positive or non-integer amount (fail closed)', () => {
    expect(() => assertRefundAmount(0)).toThrow(/positive integer/);
    expect(() => assertRefundAmount(-5)).toThrow(/positive integer/);
    expect(() => assertRefundAmount(12.5)).toThrow(/positive integer/);
  });

  it('rejects refunding more than the original charge', () => {
    expect(() => assertRefundAmount(1500, 1000)).toThrow(/exceeds the original charge/);
  });
});

describe('prorateRefundMinor', () => {
  const period = { periodStart: '2026-06-01T00:00:00.000Z', periodEnd: '2026-07-01T00:00:00.000Z' };

  it('refunds the full charge when offboarding at/before the period start', () => {
    expect(
      prorateRefundMinor({ chargeAmountMinor: 200, ...period, asOf: '2026-06-01T00:00:00.000Z' }),
    ).toBe(200);
    expect(
      prorateRefundMinor({ chargeAmountMinor: 200, ...period, asOf: '2026-05-20T00:00:00.000Z' }),
    ).toBe(200);
  });

  it('refunds nothing when the period is fully consumed (asOf at/after the end)', () => {
    expect(
      prorateRefundMinor({ chargeAmountMinor: 200, ...period, asOf: '2026-07-01T00:00:00.000Z' }),
    ).toBe(0);
    expect(
      prorateRefundMinor({ chargeAmountMinor: 200, ...period, asOf: '2026-08-01T00:00:00.000Z' }),
    ).toBe(0);
  });

  it('prorates the unused fraction (half the 30-day period left → half the charge)', () => {
    expect(
      prorateRefundMinor({ chargeAmountMinor: 200, ...period, asOf: '2026-06-16T00:00:00.000Z' }),
    ).toBe(100);
  });

  it('rounds half-up to whole minor units and never exceeds the original charge', () => {
    // 1 of 30 days used → 29/30 unused × 100 = 96.67 → 97.
    const r = prorateRefundMinor({
      chargeAmountMinor: 100,
      ...period,
      asOf: '2026-06-02T00:00:00.000Z',
    });
    expect(r).toBe(97);
    expect(r).toBeLessThanOrEqual(100);
  });

  it('rejects a non-positive charge amount and an invalid/empty period', () => {
    expect(() =>
      prorateRefundMinor({ chargeAmountMinor: 0, ...period, asOf: period.periodStart }),
    ).toThrow(/positive integer/);
    expect(() =>
      prorateRefundMinor({
        chargeAmountMinor: 200,
        periodStart: '2026-07-01T00:00:00.000Z',
        periodEnd: '2026-06-01T00:00:00.000Z',
        asOf: '2026-06-15T00:00:00.000Z',
      }),
    ).toThrow(/end must be after start/);
    expect(() =>
      prorateRefundMinor({
        chargeAmountMinor: 200,
        periodStart: 'nope',
        periodEnd: period.periodEnd,
        asOf: period.periodStart,
      }),
    ).toThrow(/valid ISO-8601 dates/);
  });
});

describe('refundIdempotencyKey', () => {
  it('is deterministic; full and partial (and different partials) get distinct keys', () => {
    const full = refundIdempotencyKey('ch_1');
    expect(refundIdempotencyKey('ch_1')).toBe(full); // stable
    expect(full).toBe('tenantforge:refund:ch_1:full');
    const partial = refundIdempotencyKey('ch_1', 500);
    expect(partial).toBe('tenantforge:refund:ch_1:500');
    expect(new Set([full, partial, refundIdempotencyKey('ch_1', 600)]).size).toBe(3);
  });
});
