import { describe, expect, it } from 'vitest';
import { invoiceEmailIdempotencyKey, renderInvoiceEmail } from '../../src/core/invoice-email.js';

const data = {
  tenantSlug: 'acme',
  periodStart: '2026-06-01T00:00:00.000Z',
  periodEnd: '2026-07-01T00:00:00.000Z',
  currency: 'USD',
  lineItems: [
    { description: 'Base plan fee', amountUsd: 49 },
    { description: 'Compute time (overage; 60 compute-second incl.)', amountUsd: 1.5 },
  ],
  totalUsd: 50.5,
};

describe('renderInvoiceEmail', () => {
  it('renders a subject with the period + total and a body listing each line', () => {
    const out = renderInvoiceEmail(data);
    expect(out.subject).toBe('Your invoice for 2026-06-01–2026-07-01: 50.50 USD');
    expect(out.body).toContain('Hi acme,');
    expect(out.body).toContain('• Base plan fee: 49.00 USD');
    expect(out.body).toContain('• Compute time (overage; 60 compute-second incl.): 1.50 USD');
    expect(out.body).toContain('Total: 50.50 USD');
  });

  it('handles an invoice with no billable lines', () => {
    const out = renderInvoiceEmail({ ...data, lineItems: [], totalUsd: 0 });
    expect(out.body).toContain('(no billable lines)');
    expect(out.body).toContain('Total: 0.00 USD');
  });
});

describe('invoiceEmailIdempotencyKey', () => {
  it('is stable per tenant + period', () => {
    expect(invoiceEmailIdempotencyKey('t1', data.periodStart, data.periodEnd)).toBe(
      'tenantforge:invoice-email:t1:2026-06-01T00:00:00.000Z..2026-07-01T00:00:00.000Z',
    );
  });
});
