import { describe, expect, it } from 'vitest';
import { invoiceChargeAmount, chargeIdempotencyKey } from '../../src/core/billing.js';
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
});
