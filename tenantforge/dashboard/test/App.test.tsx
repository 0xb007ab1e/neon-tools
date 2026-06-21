import { fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';

const report = {
  generatedAt: '2026-06-20T00:00:00.000Z',
  inventory: {
    total: 2,
    byStatus: { provisioning: 0, active: 2, suspended: 0, offboarding: 0, deleted: 0 },
  },
  isolation: { compliant: true, missingProject: [], sharedProjects: [] },
  residency: {
    compliant: false,
    allowedRegions: ['aws-us-east-1'],
    byJurisdiction: { us: 1, eu: 1 },
    violations: [
      { tenantId: 'tenant-b', region: 'aws-eu-central-1', reason: 'region not in org allow-list' },
    ],
  },
  audit: {
    erasures: [
      {
        at: '2026-06-19T00:00:00.000Z',
        event: 'tenant.transition',
        outcome: 'ok',
        actor: { id: 'op', role: 'admin' },
        tenantId: 'tenant-gone',
      },
    ],
    recent: [{ at: '2026-06-19T00:00:00.000Z', event: 'tenant.transition', outcome: 'ok' }],
  },
};
const drift = {
  latest: '0003',
  totalVersions: 3,
  summary: { total: 2, atLatest: 1, drifted: 1, withFailures: 0 },
};
const cost = {
  generatedAt: '2026-06-20T00:00:00.000Z',
  rows: [{ tenantId: 'tenant-a', costUsd: 10, priceUsd: 5, marginUsd: -5, unprofitable: true }],
  unmetered: [],
  totals: { tenants: 1, costUsd: 10, priceUsd: 5, marginUsd: -5, unprofitable: 1, unpriced: 0 },
};
const reconcile = {
  target: '0003',
  perTenant: [{ tenantId: 'tenant-behind', missing: ['0002', '0003'] }],
  pendingTenants: ['tenant-behind'],
  upToDate: [],
  totalMissing: 2,
};
const reconcileHistory = [
  {
    at: '2026-06-19T12:00:00.000Z',
    outcome: 'ok',
    actor: { id: 'op', role: 'admin' },
    context: { target: '0003', reconciled: 4, partial: 0 },
  },
];
const invoices = {
  generatedAt: '2026-06-20T00:00:00.000Z',
  invoices: [
    {
      tenantId: 'tenant-billed',
      currency: 'USD',
      totalUsd: 12,
      lineItems: [
        { description: 'Base plan fee', quantity: 1, unit: 'period', amountUsd: 10 },
        {
          description: 'Compute time (overage; 60 compute-second incl.)',
          quantity: 40,
          unit: 'compute-second',
          amountUsd: 2,
        },
      ],
    },
  ],
  unmetered: [],
};
const charges = [
  {
    at: '2026-06-20T00:00:00.000Z',
    outcome: 'ok',
    tenantId: 'tenant-charged',
    context: {
      provider: 'stripe',
      chargeId: 'ch_1',
      amountMinor: 1200,
      currency: 'usd',
      status: 'succeeded',
    },
  },
];
const paymentEvents = [
  {
    at: '2026-06-20T01:00:00.000Z',
    outcome: 'ok',
    tenantId: 'tenant-hooked',
    context: { type: 'charge.succeeded', rawType: 'payment_intent.succeeded', chargeId: 'pi_1' },
  },
];
const dunning = [
  {
    at: '2026-06-20T02:00:00.000Z',
    outcome: 'ok',
    tenantId: 'tenant-dunned',
    context: { action: 'retry', attempt: 2, status: 'succeeded' },
  },
];
const billingRuns = [
  {
    at: '2026-06-20T03:00:00.000Z',
    outcome: 'ok',
    context: { charged: 7, chargeFailed: 0, retried: 1, suspended: 0, dunningFailed: 0 },
  },
];
const refunds = [
  {
    at: '2026-06-20T04:00:00.000Z',
    outcome: 'ok',
    tenantId: 'tenant-refunded',
    context: {
      refundId: 're_1',
      chargeId: 'ch_1',
      amountMinor: 500,
      currency: 'usd',
      status: 'succeeded',
    },
  },
];
const notifications = [
  {
    at: '2026-06-20T05:00:00.000Z',
    outcome: 'ok',
    tenantId: 'tenant-notified',
    context: { provider: 'log', kind: 'charge', reference: 'ch_1', status: 'queued' },
  },
];
const planChanges = [
  {
    at: '2026-06-20T07:00:00.000Z',
    outcome: 'ok',
    tenantId: 'tenant-replanned',
    context: { oldPriceUsd: 10, newPriceUsd: 20, proratedDeltaMinor: 500, settlement: 'charged' },
  },
];
const creditGrants = [
  {
    at: '2026-06-20T08:00:00.000Z',
    outcome: 'ok',
    tenantId: 'tenant-credited',
    context: { amountMinor: 1000, currency: 'usd', reason: 'goodwill' },
  },
];

const usageAlerts = [
  {
    at: '2026-06-20T09:00:00.000Z',
    outcome: 'ok',
    tenantId: 'tenant-near-limit',
    context: {
      alerts: [{ metric: 'computeTimeSeconds', usedFraction: 0.9, thresholdCrossed: 0.8 }],
    },
  },
];

const plans = [
  { id: 'pro', name: 'Pro plan', priceUsd: 49, includedUsage: { computeTimeSeconds: 10000 } },
];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let authed = false;
let reconcileExecutable = false;
beforeEach(() => {
  authed = false;
  reconcileExecutable = false;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/session') && method === 'GET') {
        return Promise.resolve(authed ? json({ id: 'op', role: 'admin' }) : json({}, 401));
      }
      if (url.endsWith('/session') && method === 'POST') {
        authed = true;
        return Promise.resolve(json({ id: 'op', role: 'admin' }));
      }
      if (url.endsWith('/compliance'))
        return Promise.resolve(json({ report, digest: 'abc123def456' }));
      if (url.endsWith('/drift')) return Promise.resolve(json(drift));
      if (url.endsWith('/reconcile-history'))
        return Promise.resolve(json({ history: reconcileHistory }));
      if (url.endsWith('/reconcile/capabilities'))
        return Promise.resolve(json({ executable: reconcileExecutable, mayExecute: true }));
      if (url.endsWith('/reconcile') && method === 'POST')
        return Promise.resolve(json({ target: '0003', reconciled: ['t1', 't2'], partial: [] }));
      if (url.endsWith('/reconcile')) return Promise.resolve(json(reconcile));
      if (url.endsWith('/invoices')) return Promise.resolve(json(invoices));
      if (url.endsWith('/payment-events')) return Promise.resolve(json({ events: paymentEvents }));
      if (url.endsWith('/billing-runs')) return Promise.resolve(json({ runs: billingRuns }));
      if (url.endsWith('/notifications')) return Promise.resolve(json({ notifications }));
      if (url.endsWith('/plan-changes')) return Promise.resolve(json({ planChanges }));
      if (url.endsWith('/credit-grants')) return Promise.resolve(json({ creditGrants }));
      if (url.endsWith('/usage-alerts')) return Promise.resolve(json({ usageAlerts }));
      if (url.endsWith('/plans')) return Promise.resolve(json({ plans }));
      if (url.endsWith('/refunds')) return Promise.resolve(json({ refunds }));
      if (url.endsWith('/dunning')) return Promise.resolve(json({ events: dunning }));
      if (url.endsWith('/charges')) return Promise.resolve(json({ charges }));
      if (url.endsWith('/cost')) return Promise.resolve(json(cost));
      return Promise.resolve(json({}, 404));
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('dashboard App', () => {
  it('shows the login form when unauthenticated, no a11y violations', async () => {
    const { container } = render(<App />);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByLabelText('Operator token')).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('logs in and renders all three panels (compliance, drift, cost), no a11y violations', async () => {
    const { container } = render(<App />);
    fireEvent.change(await screen.findByLabelText('Operator token'), {
      target: { value: 'op-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText(/Signed in as/)).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Compliance' })).toBeInTheDocument();
    expect(await screen.findByText('region not in org allow-list')).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'Fleet migration drift' }),
    ).toBeInTheDocument();
    // Reconcile plan preview renders the behind tenant.
    expect(
      await screen.findByRole('heading', { name: 'Fleet reconcile (plan)' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('tenant-behind')).toBeInTheDocument();
    // Reconcile history (from the audit trail) renders.
    expect(await screen.findByText('Recent reconcile runs (audit trail)')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Cost & margin' })).toBeInTheDocument();
    // The unprofitable tenant row is rendered.
    expect(await screen.findByText('tenant-a')).toBeInTheDocument();
    // Erasure history (from the persisted audit trail) is shown.
    expect(await screen.findByText('Erasures recorded: 1')).toBeInTheDocument();
    expect(await screen.findByText('tenant-gone')).toBeInTheDocument();
    // Invoices panel renders.
    expect(
      await screen.findByRole('heading', { name: 'Invoices (this month)' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('tenant-billed')).toBeInTheDocument();
    // The overage line item (from an included allowance) is surfaced in the invoices panel.
    expect(
      await screen.findByText(/Compute time \(overage; 60 compute-second incl\.\): 40/),
    ).toBeInTheDocument();
    // Billing (recent charges) panel renders.
    expect(
      await screen.findByRole('heading', { name: 'Billing (recent charges)' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('tenant-charged')).toBeInTheDocument();
    // Inbound PSP webhook events render in the billing panel.
    expect(await screen.findByText('Recent inbound PSP webhook events')).toBeInTheDocument();
    expect(await screen.findByText('tenant-hooked')).toBeInTheDocument();
    // Dunning (failed-charge retries) render in the billing panel.
    expect(await screen.findByText('Recent dunning (failed-charge retries)')).toBeInTheDocument();
    expect(await screen.findByText('tenant-dunned')).toBeInTheDocument();
    // Billing runs render in the billing panel.
    expect(await screen.findByText('Recent billing runs')).toBeInTheDocument();
    // Refunds render in the billing panel.
    expect(await screen.findByText('Recent refunds')).toBeInTheDocument();
    expect(await screen.findByText('tenant-refunded')).toBeInTheDocument();
    // Receipt notifications render in the billing panel.
    expect(await screen.findByText('Recent receipts (notifications)')).toBeInTheDocument();
    expect(await screen.findByText('tenant-notified')).toBeInTheDocument();
    // Plan changes render in the billing panel.
    expect(await screen.findByText('Recent plan changes')).toBeInTheDocument();
    expect(await screen.findByText('tenant-replanned')).toBeInTheDocument();
    // Credit grants render in the billing panel.
    expect(await screen.findByText('Recent credit grants')).toBeInTheDocument();
    expect(await screen.findByText('tenant-credited')).toBeInTheDocument();
    // Usage alerts render in the billing panel.
    expect(
      await screen.findByText('Recent usage alerts (approaching/over plan allowance)'),
    ).toBeInTheDocument();
    expect(await screen.findByText('tenant-near-limit')).toBeInTheDocument();
    // Plan catalog renders.
    expect(await screen.findByRole('heading', { name: 'Plan catalog' })).toBeInTheDocument();
    expect(await screen.findByText('Pro plan')).toBeInTheDocument();
    // Reconcile execution is not enabled by default → preview-only, no Run button.
    expect(screen.queryByRole('button', { name: 'Run reconcile' })).toBeNull();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('runs a reconcile from the dashboard when executable + permitted (confirmed)', async () => {
    reconcileExecutable = true;
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Operator token'), {
      target: { value: 'op-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    const run = await screen.findByRole('button', { name: 'Run reconcile' });
    fireEvent.click(run);
    expect(confirmSpy).toHaveBeenCalled();
    // The POST result is surfaced.
    expect(await screen.findByText('Reconciled 2 tenant(s), 0 with failures.')).toBeInTheDocument();
    confirmSpy.mockRestore();
  });
});
