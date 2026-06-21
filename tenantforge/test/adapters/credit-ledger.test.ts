import { describe, expect, it } from 'vitest';
import { createInMemoryCreditLedger } from '../../src/adapters/credit-ledger.js';

describe('createInMemoryCreditLedger', () => {
  it('grants raise the balance; balance is per-tenant and per-currency', async () => {
    const led = createInMemoryCreditLedger();
    await led.grant({ tenantId: 't-a', amountMinor: 1000, currency: 'usd', reason: 'goodwill' });
    await led.grant({ tenantId: 't-a', amountMinor: 500, currency: 'EUR', reason: 'x' });
    await led.grant({ tenantId: 't-b', amountMinor: 9999, currency: 'usd', reason: 'x' });
    expect(await led.balance('t-a', 'usd')).toBe(1000);
    expect(await led.balance('t-a', 'eur')).toBe(500); // currency-scoped + lowercased
    expect(await led.balance('t-a', 'gbp')).toBe(0);
    expect(await led.balance('t-b', 'usd')).toBe(9999); // tenant-scoped
  });

  it('consume draws down to a floor of zero and is idempotent on the reference', async () => {
    const led = createInMemoryCreditLedger();
    await led.grant({ tenantId: 't', amountMinor: 1000, currency: 'usd', reason: 'x' });
    const first = await led.consume({
      tenantId: 't',
      amountMinor: 300,
      currency: 'usd',
      reason: 'charge',
      reference: 'period-jun',
    });
    expect(first.consumedMinor).toBe(300);
    expect(await led.balance('t', 'usd')).toBe(700);
    // Same reference again → no-op, returns the original amount, balance unchanged.
    const repeat = await led.consume({
      tenantId: 't',
      amountMinor: 300,
      currency: 'usd',
      reason: 'charge',
      reference: 'period-jun',
    });
    expect(repeat.consumedMinor).toBe(300);
    expect(await led.balance('t', 'usd')).toBe(700);
  });

  it('consume never exceeds the available balance', async () => {
    const led = createInMemoryCreditLedger();
    await led.grant({ tenantId: 't', amountMinor: 200, currency: 'usd', reason: 'x' });
    const r = await led.consume({
      tenantId: 't',
      amountMinor: 1000,
      currency: 'usd',
      reason: 'charge',
      reference: 'p1',
    });
    expect(r.consumedMinor).toBe(200);
    expect(await led.balance('t', 'usd')).toBe(0);
  });

  it('history is newest-first and tenant-scoped', async () => {
    const led = createInMemoryCreditLedger();
    await led.grant({ tenantId: 't', amountMinor: 100, currency: 'usd', reason: 'first' });
    await led.grant({ tenantId: 't', amountMinor: 200, currency: 'usd', reason: 'second' });
    const h = await led.history('t', 10);
    expect(h.map((e) => e.reason)).toEqual(['second', 'first']);
    expect(await led.history('other', 10)).toEqual([]);
  });
});
