import { describe, expect, it } from 'vitest';
import { buildInvoice } from '../../src/core/invoice.js';
import type { Consumption } from '../../src/core/usage.js';

const consumption: Consumption = {
  computeTimeSeconds: 100,
  activeTimeSeconds: 50,
  syntheticStorageBytes: 1_000_000,
  writtenDataBytes: 2_000_000,
};
const period = {
  from: new Date('2026-06-01T00:00:00.000Z'),
  to: new Date('2026-07-01T00:00:00.000Z'),
};
const now = new Date('2026-07-01T12:00:00.000Z');

describe('buildInvoice', () => {
  it('bills each dimension that has a configured rate, plus a base fee, and totals them', () => {
    const inv = buildInvoice(consumption, {
      tenantId: 't1',
      period,
      now,
      baseFeeUsd: 20,
      billingRates: { computeSecondUsd: 0.01, writtenByteUsd: 0.000001 },
    });
    expect(inv.tenantId).toBe('t1');
    expect(inv.currency).toBe('USD');
    expect(inv.periodStart).toBe('2026-06-01T00:00:00.000Z');
    expect(inv.generatedAt).toBe('2026-07-01T12:00:00.000Z');
    // base fee (20) + compute (100 * 0.01 = 1) + written (2_000_000 * 0.000001 = 2). Storage/active
    // have no rate → no line.
    expect(inv.lineItems.map((li) => li.description)).toEqual([
      'Base plan fee',
      'Compute time',
      'Data written',
    ]);
    expect(inv.lineItems.map((li) => li.amountUsd)).toEqual([20, 1, 2]);
    expect(inv.totalUsd).toBe(23);
  });

  it('omits the base fee when it is unset or zero, and bills nothing when no rates are set', () => {
    const inv = buildInvoice(consumption, { tenantId: 't2', period, now, billingRates: {} });
    expect(inv.lineItems).toEqual([]);
    expect(inv.totalUsd).toBe(0);

    const zeroFee = buildInvoice(consumption, {
      tenantId: 't3',
      period,
      now,
      baseFeeUsd: 0,
      billingRates: {},
    });
    expect(zeroFee.lineItems).toEqual([]);
  });

  it('rounds line amounts to cents and honors a currency override', () => {
    const inv = buildInvoice(consumption, {
      tenantId: 't4',
      period,
      now,
      currency: 'usd-test',
      billingRates: { computeSecondUsd: 0.012345 }, // 100 * 0.012345 = 1.2345 → 1.23
    });
    expect(inv.currency).toBe('usd-test');
    expect(inv.lineItems[0]?.amountUsd).toBe(1.23);
    expect(inv.totalUsd).toBe(1.23);
  });
});
