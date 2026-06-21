import { describe, expect, it } from 'vitest';
import { renderReceipt, receiptIdempotencyKey, formatMoney } from '../../src/core/receipts.js';
import type { ReceiptData } from '../../src/core/receipts.js';

const base: ReceiptData = {
  kind: 'charge',
  tenantSlug: 'acme',
  amountMinor: 1234,
  currency: 'usd',
  reference: 'ch_1',
  at: '2026-06-20T00:00:00.000Z',
};

describe('formatMoney', () => {
  it('formats minor units as major with the uppercased currency', () => {
    expect(formatMoney(1234, 'usd')).toBe('12.34 USD');
    expect(formatMoney(900, 'eur')).toBe('9.00 EUR');
    expect(formatMoney(0, 'usd')).toBe('0.00 USD');
  });
});

describe('renderReceipt', () => {
  it('renders a charge receipt with amount, reference, and date — and no card data/recipient', () => {
    const r = renderReceipt(base);
    expect(r.subject).toBe('Your receipt for 12.34 USD');
    expect(r.body).toContain('acme');
    expect(r.body).toContain('12.34 USD');
    expect(r.body).toContain('ch_1');
    expect(r.body).toContain('2026-06-20T00:00:00.000Z');
    expect(r.body.toLowerCase()).not.toContain('card');
  });

  it('renders a refund receipt with refund wording', () => {
    const r = renderReceipt({ ...base, kind: 'refund', reference: 're_1' });
    expect(r.subject).toBe('Your refund of 12.34 USD');
    expect(r.body).toContain("We've refunded 12.34 USD");
    expect(r.body).toContain('re_1');
  });
});

describe('receiptIdempotencyKey', () => {
  it('is deterministic and distinct per kind + reference', () => {
    expect(receiptIdempotencyKey('charge', 'ch_1')).toBe('tenantforge:receipt:charge:ch_1');
    expect(receiptIdempotencyKey('refund', 'ch_1')).toBe('tenantforge:receipt:refund:ch_1');
    expect(receiptIdempotencyKey('charge', 'ch_1')).toBe(receiptIdempotencyKey('charge', 'ch_1'));
    expect(receiptIdempotencyKey('charge', 'ch_1')).not.toBe(
      receiptIdempotencyKey('charge', 'ch_2'),
    );
  });
});
