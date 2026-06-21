import { describe, expect, it } from 'vitest';
import { applyIncludedAllowance, buildInvoice } from '../../src/core/invoice.js';
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

  describe('included allowances (overage billing)', () => {
    it('bills only the overage above each allowance and labels the line', () => {
      const inv = buildInvoice(consumption, {
        tenantId: 't5',
        period,
        now,
        billingRates: { computeSecondUsd: 0.01, writtenByteUsd: 0.000001 },
        // compute: 100 used − 60 incl = 40 overage → 0.40; written: 2_000_000 − 500_000 = 1_500_000 → 1.50
        included: { computeTimeSeconds: 60, writtenDataBytes: 500_000 },
      });
      expect(inv.lineItems.map((li) => li.description)).toEqual([
        'Compute time (overage; 60 compute-second incl.)',
        'Data written (overage; 500000 byte incl.)',
      ]);
      expect(inv.lineItems.map((li) => li.quantity)).toEqual([40, 1_500_000]);
      expect(inv.lineItems.map((li) => li.amountUsd)).toEqual([0.4, 1.5]);
      expect(inv.totalUsd).toBe(1.9);
    });

    it('emits no line for a dimension fully within its allowance', () => {
      const inv = buildInvoice(consumption, {
        tenantId: 't6',
        period,
        now,
        billingRates: { computeSecondUsd: 0.01 }, // 100 used ≤ 100 incl → no overage line
        included: { computeTimeSeconds: 100 },
      });
      expect(inv.lineItems).toEqual([]);
      expect(inv.totalUsd).toBe(0);
    });

    it('treats a zero or unset allowance as no allowance (pre-allowance behavior, line kept)', () => {
      const inv = buildInvoice(consumption, {
        tenantId: 't7',
        period,
        now,
        billingRates: { computeSecondUsd: 0.01, activeSecondUsd: 0.02 },
        // compute allowance 0 ⇒ bill all 100 (label unchanged); active unset ⇒ bill all 50.
        included: { computeTimeSeconds: 0 },
      });
      expect(inv.lineItems.map((li) => li.description)).toEqual([
        'Compute time',
        'Active compute time',
      ]);
      expect(inv.lineItems.map((li) => li.quantity)).toEqual([100, 50]);
    });
  });
});

describe('applyIncludedAllowance', () => {
  it('subtracts allowances per dimension, clamping at zero', () => {
    expect(
      applyIncludedAllowance(consumption, {
        computeTimeSeconds: 60,
        activeTimeSeconds: 50, // exactly used → 0
        syntheticStorageBytes: 2_000_000, // more than used → clamps to 0
        writtenDataBytes: 500_000,
      }),
    ).toEqual({
      computeTimeSeconds: 40,
      activeTimeSeconds: 0,
      syntheticStorageBytes: 0,
      writtenDataBytes: 1_500_000,
    });
  });

  it('subtracts nothing for an empty allowance', () => {
    expect(applyIncludedAllowance(consumption, {})).toEqual(consumption);
  });
});
