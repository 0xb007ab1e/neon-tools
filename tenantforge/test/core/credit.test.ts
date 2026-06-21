import { describe, expect, it } from 'vitest';
import { creditBalanceMinor, creditToApply } from '../../src/core/credit.js';

describe('creditBalanceMinor', () => {
  it('sums grants minus consumptions for the matching currency (case-insensitive)', () => {
    const entries = [
      { amountMinor: 1000, currency: 'usd' },
      { amountMinor: -300, currency: 'USD' },
      { amountMinor: 5000, currency: 'eur' }, // other currency — ignored
    ];
    expect(creditBalanceMinor(entries, 'usd')).toBe(700);
    expect(creditBalanceMinor(entries, 'eur')).toBe(5000);
    expect(creditBalanceMinor(entries, 'gbp')).toBe(0);
  });

  it('clamps a negative total to zero (defensive)', () => {
    expect(creditBalanceMinor([{ amountMinor: -50, currency: 'usd' }], 'usd')).toBe(0);
  });
});

describe('creditToApply', () => {
  it('applies the lesser of balance and amount due, never negative', () => {
    expect(creditToApply(1000, 300)).toBe(300); // due < balance
    expect(creditToApply(200, 1000)).toBe(200); // balance < due
    expect(creditToApply(0, 1000)).toBe(0);
    expect(creditToApply(1000, 0)).toBe(0);
    expect(creditToApply(-5, 1000)).toBe(0); // never negative
  });
});
