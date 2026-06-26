import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
const retention = {
  generatedAt: '2026-06-30T00:00:00.000Z',
  retentionDays: 30,
  eligible: 1,
  pending: 0,
  tenants: [
    {
      tenantId: 'tenant-archived',
      slug: 'archived',
      archivedAt: '2026-05-01T00:00:00.000Z',
      purgeEligibleAt: '2026-05-31T00:00:00.000Z',
      eligible: true,
    },
  ],
};
const dataExports = [
  {
    at: '2026-06-20T12:00:00.000Z',
    outcome: 'ok',
    tenantId: 'tenant-exported',
    context: { location: 's3://exports/tenant-exported.tar', bytes: 4096 },
  },
];
const reconcileHistory = [
  {
    at: '2026-06-19T12:00:00.000Z',
    outcome: 'ok',
    actor: { id: 'op', role: 'admin' },
    context: { target: '0003', reconciled: 4, partial: 0 },
  },
];
const evidenceManifests = [
  {
    bundleId: 'evb-abc123def456789',
    scope: 'fleet',
    generatedAt: '2026-06-20T00:00:00.000Z',
    storedAt: '2026-06-20T00:00:01.000Z',
    signerKid: 'compliance-evidence-2026',
    contentHashes: {
      inventory: 'h1',
      isolation: 'h2',
      residency: 'h3',
      auditExcerpt: 'h4',
      erasureCertificates: 'h5',
    },
    retentionUntil: '2026-09-18T00:00:01.000Z',
  },
];
const evidenceBundle = {
  bundle: {
    scope: 'fleet',
    generatedAt: '2026-06-20T00:00:00.000Z',
    artifacts: {
      inventory: { total: 2, byStatus: {} },
      isolation: { compliant: true, missingProject: [], sharedProjects: [] },
      residency: { compliant: true, allowedRegions: [], byJurisdiction: {}, violations: [] },
      auditExcerpt: [],
      erasureCertificates: ['cert.jws.one'],
    },
    contentHashes: {
      inventory: 'h1',
      isolation: 'h2',
      residency: 'h3',
      auditExcerpt: 'h4',
      erasureCertificates: 'h5',
    },
  },
  jws: 'eyJhbGciOiJFZERTQSJ9.payload.signature',
};
const evidencePublicKey = {
  kty: 'OKP',
  crv: 'Ed25519',
  x: 'publickeybytes',
  kid: 'compliance-evidence-2026',
};
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

const signupTokens = [
  {
    slug: 'tenant-invited',
    status: 'pending',
    expiresAt: '2026-07-01T00:00:00.000Z',
    createdAt: '2026-06-20T00:00:00.000Z',
  },
];

const invoicesSent = [
  {
    at: '2026-06-20T10:00:00.000Z',
    outcome: 'ok',
    tenantId: 'tenant-emailed',
    context: { totalUsd: 50.5, status: 'queued' },
  },
];

const auditEvents = [
  {
    at: '2026-06-20T11:00:00.000Z',
    event: 'tenant.transition',
    outcome: 'ok',
    tenantId: 'tenant-audited',
    actor: { id: 'op', role: 'admin' },
  },
];

const auditAnomalies = [
  { kind: 'tenant-errors', subject: 'tenant-flaky', count: 6, events: ['tenant.charged'] },
];

const costAnomalies = [
  {
    kind: 'unprofitable',
    tenantId: 'tenant-underwater',
    costUsd: 30,
    priceUsd: 20,
    marginUsd: -10,
  },
];

const operatorDigest = {
  generatedAt: '2026-06-20T00:00:00.000Z',
  severity: 'critical',
  totalIssues: 3,
  headline: 'critical: 3 issues across cost, audit, drift',
  categories: [
    {
      category: 'cost',
      severity: 'critical',
      count: 1,
      detail: '1 anomaly (incl. unprofitable tenants)',
    },
    { category: 'audit', severity: 'warning', count: 1, detail: '1 anomaly' },
    { category: 'drift', severity: 'warning', count: 1, detail: '1 tenant behind target 0003' },
    {
      category: 'retention',
      severity: 'ok',
      count: 0,
      detail: 'none past retention (0 within window)',
    },
    { category: 'usage', severity: 'ok', count: 0, detail: 'usage within allowances' },
  ],
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let authed = false;
let reconcileExecutable = false;
beforeEach(() => {
  authed = false;
  reconcileExecutable = false;
  window.location.hash = ''; // reset routed section between tests
  document.documentElement.removeAttribute('data-theme');
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
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
      if (url.endsWith('/operator-digest')) return Promise.resolve(json(operatorDigest));
      if (url.endsWith('/webhook-subscriptions'))
        return Promise.resolve(
          json({
            subscriptions: [
              {
                id: 's1',
                url: 'https://hook.test/x',
                eventTypes: [],
                active: true,
                createdAt: 'x',
              },
            ],
          }),
        );
      if (url.endsWith('/evidence/public-key'))
        return Promise.resolve(json({ publicKey: evidencePublicKey }));
      if (url.includes('/evidence/bundles/'))
        return Promise.resolve(json({ bundle: evidenceBundle.bundle, jws: evidenceBundle.jws }));
      if (url.endsWith('/evidence/bundles'))
        return Promise.resolve(json({ manifests: evidenceManifests }));
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
      if (url.endsWith('/exports')) return Promise.resolve(json({ exports: dataExports }));
      if (url.endsWith('/retention')) return Promise.resolve(json(retention));
      if (url.endsWith('/invoices')) return Promise.resolve(json(invoices));
      if (url.endsWith('/payment-events')) return Promise.resolve(json({ events: paymentEvents }));
      if (url.endsWith('/billing-runs')) return Promise.resolve(json({ runs: billingRuns }));
      if (url.endsWith('/notifications')) return Promise.resolve(json({ notifications }));
      if (url.endsWith('/plan-changes')) return Promise.resolve(json({ planChanges }));
      if (url.endsWith('/credit-grants')) return Promise.resolve(json({ creditGrants }));
      if (url.endsWith('/usage-alerts')) return Promise.resolve(json({ usageAlerts }));
      if (url.endsWith('/signup-tokens')) return Promise.resolve(json({ signupTokens }));
      if (url.endsWith('/plans')) return Promise.resolve(json({ plans }));
      if (url.endsWith('/invoices-sent')) return Promise.resolve(json({ invoicesSent }));
      if (url.endsWith('/audit-anomalies'))
        return Promise.resolve(json({ anomalies: auditAnomalies }));
      if (url.endsWith('/audit')) return Promise.resolve(json({ events: auditEvents }));
      if (url.endsWith('/refunds')) return Promise.resolve(json({ refunds }));
      if (url.endsWith('/dunning')) return Promise.resolve(json({ events: dunning }));
      if (url.endsWith('/charges')) return Promise.resolve(json({ charges }));
      if (url.endsWith('/cost-anomalies'))
        return Promise.resolve(json({ anomalies: costAnomalies }));
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

  const signIn = async (): Promise<void> => {
    fireEvent.change(await screen.findByLabelText('Operator token'), {
      target: { value: 'op-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText(/Signed in as/);
  };

  it('logs in to the Health section by default, then navigates to Fleet, no a11y violations', async () => {
    const { container } = render(<App />);
    await signIn();

    // Health section (default route): the operator digest roll-up.
    expect(await screen.findByRole('heading', { name: 'Operator digest' })).toBeInTheDocument();
    expect(
      await screen.findByText('critical: 3 issues across cost, audit, drift'),
    ).toBeInTheDocument();
    // The Health section also shows the webhook subscriptions panel.
    expect(
      await screen.findByRole('heading', { name: 'Webhook subscriptions' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('https://hook.test/x')).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);

    // Navigate to the Fleet section: compliance, drift, reconcile.
    fireEvent.click(await screen.findByRole('link', { name: 'Fleet' }));
    expect(await screen.findByRole('heading', { name: 'Compliance' })).toBeInTheDocument();
    expect(await screen.findByText('region not in org allow-list')).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'Fleet migration drift' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'Fleet reconcile (plan)' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('tenant-behind')).toBeInTheDocument();
    expect(await screen.findByText('Recent reconcile runs (audit trail)')).toBeInTheDocument();
    // Erasure history (from the persisted audit trail) is shown in the compliance panel.
    expect(await screen.findByText('Erasures recorded: 1')).toBeInTheDocument();
    expect(await screen.findByText('tenant-gone')).toBeInTheDocument();
    // Data exports (portability / DSAR) render in the fleet section.
    expect(
      await screen.findByRole('heading', { name: 'Data exports (portability / DSAR)' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('tenant-exported')).toBeInTheDocument();
    // Retention (scheduled purges) renders in the fleet section.
    expect(
      await screen.findByRole('heading', { name: 'Retention (scheduled purges)' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('tenant-archived')).toBeInTheDocument();
    // Signed evidence bundles panel renders its manifest list (facts only).
    expect(
      await screen.findByRole('heading', { name: 'Signed evidence bundles' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText('Persisted evidence-bundle manifests (facts only — no bundle body)'),
    ).toBeInTheDocument();
    expect(await screen.findByText('compliance-evidence-2026')).toBeInTheDocument();
    // Reconcile execution is not enabled by default → preview-only, no Run button.
    expect(screen.queryByRole('button', { name: 'Run reconcile' })).toBeNull();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('views a signed evidence bundle and loads the public verification key, no a11y violations', async () => {
    const { container } = render(<App />);
    await signIn();
    fireEvent.click(await screen.findByRole('link', { name: 'Fleet' }));

    // Open the bundle detail via the per-row View action; the signed JWS is offered as a download.
    fireEvent.click(await screen.findByRole('button', { name: 'View bundle evb-abc123def456789' }));
    expect(
      await screen.findByRole('button', { name: 'Download signed bundle' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByLabelText('Signed bundle (compact JWS — verify offline, do not edit)'),
    ).toHaveValue('eyJhbGciOiJFZERTQSJ9.payload.signature');

    // The public key loads on demand (public material only) and is downloadable.
    fireEvent.click(screen.getByRole('button', { name: 'Show public verification key' }));
    expect(
      await screen.findByLabelText('Ed25519 public JWK (verify bundles offline)'),
    ).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Download public key' })).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('navigates to the Billing section and renders its panels, no a11y violations', async () => {
    const { container } = render(<App />);
    await signIn();
    fireEvent.click(await screen.findByRole('link', { name: 'Billing' }));

    expect(await screen.findByRole('heading', { name: 'Cost & margin' })).toBeInTheDocument();
    expect(await screen.findByText('tenant-a')).toBeInTheDocument();
    // Cost anomalies surface in the cost panel.
    expect(await screen.findByText('Cost anomalies (needs attention)')).toBeInTheDocument();
    expect(await screen.findByText('tenant-underwater')).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'Invoices (this month)' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('tenant-billed')).toBeInTheDocument();
    expect(
      await screen.findByText(/Compute time \(overage; 60 compute-second incl\.\): 40/),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'Billing (recent charges)' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('tenant-charged')).toBeInTheDocument();
    expect(await screen.findByText('Recent inbound PSP webhook events')).toBeInTheDocument();
    expect(await screen.findByText('tenant-hooked')).toBeInTheDocument();
    expect(await screen.findByText('Recent dunning (failed-charge retries)')).toBeInTheDocument();
    expect(await screen.findByText('tenant-dunned')).toBeInTheDocument();
    expect(await screen.findByText('Recent billing runs')).toBeInTheDocument();
    expect(await screen.findByText('Recent refunds')).toBeInTheDocument();
    expect(await screen.findByText('tenant-refunded')).toBeInTheDocument();
    expect(await screen.findByText('Recent receipts (notifications)')).toBeInTheDocument();
    expect(await screen.findByText('tenant-notified')).toBeInTheDocument();
    expect(await screen.findByText('Recent plan changes')).toBeInTheDocument();
    expect(await screen.findByText('tenant-replanned')).toBeInTheDocument();
    expect(await screen.findByText('Recent credit grants')).toBeInTheDocument();
    expect(await screen.findByText('tenant-credited')).toBeInTheDocument();
    expect(
      await screen.findByText('Recent usage alerts (approaching/over plan allowance)'),
    ).toBeInTheDocument();
    expect(await screen.findByText('tenant-near-limit')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Plan catalog' })).toBeInTheDocument();
    expect(await screen.findByText('Pro plan')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Signup tokens' })).toBeInTheDocument();
    expect(await screen.findByText('tenant-invited')).toBeInTheDocument();
    expect(
      await screen.findByText('Recent invoice deliveries (emailed to tenants)'),
    ).toBeInTheDocument();
    expect(await screen.findByText('tenant-emailed')).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('navigates to the Audit section and renders the audit log + anomalies, no a11y violations', async () => {
    const { container } = render(<App />);
    await signIn();
    fireEvent.click(await screen.findByRole('link', { name: 'Audit' }));

    expect(await screen.findByRole('heading', { name: 'Audit log (recent)' })).toBeInTheDocument();
    expect(await screen.findByText('tenant-audited')).toBeInTheDocument();
    expect(
      await screen.findByText(
        'Detected anomalies (error spikes / per-actor / per-tenant clusters)',
      ),
    ).toBeInTheDocument();
    expect(await screen.findByText('tenant-flaky')).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('toggles between light and dark themes and persists the choice', async () => {
    render(<App />);
    await signIn();
    const toggle = await screen.findByRole('button', { name: /Switch to (light|dark) theme/ });
    const initial = document.documentElement.getAttribute('data-theme');
    fireEvent.click(toggle);
    const next = document.documentElement.getAttribute('data-theme');
    expect(next).not.toBe(initial);
    expect(next === 'light' || next === 'dark').toBe(true);
    expect(localStorage.getItem('tf-theme')).toBe(next);
  });

  it('runs a reconcile from the dashboard when executable + permitted (confirmed)', async () => {
    reconcileExecutable = true;
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Operator token'), {
      target: { value: 'op-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    // ReconcilePanel lives in the Fleet section (Health is the default landing).
    fireEvent.click(await screen.findByRole('link', { name: 'Fleet' }));
    const run = await screen.findByRole('button', { name: 'Run reconcile' });
    fireEvent.click(run);
    expect(confirmSpy).toHaveBeenCalled();
    // The POST result is surfaced.
    expect(await screen.findByText('Reconciled 2 tenant(s), 0 with failures.')).toBeInTheDocument();
    confirmSpy.mockRestore();
  });
});

// The dashboard now uses the shared Cloudflare-style shell (AppShell/Sidebar/TopBar + responsive
// left off-canvas drawer). These assert the shell's dashboard-specific wiring on top of the panel
// behavior already covered above: the grouped left <nav> with the section links, and the narrow-
// viewport hamburger drawer (focus trap + Esc/restore) — the same shell the portal uses.
describe('dashboard App — Cloudflare shell', () => {
  const signIn = async (): Promise<void> => {
    fireEvent.change(await screen.findByLabelText('Operator token'), {
      target: { value: 'op-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText(/Signed in as/);
  };

  it('renders the grouped left sidebar nav with the section links + active item', async () => {
    render(<App />);
    await signIn();
    const nav = screen.getByRole('navigation', { name: 'Dashboard sections' });
    // All four sections are real links; Health is active by default.
    expect(within(nav).getByRole('link', { name: 'Health' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    for (const label of ['Fleet', 'Billing', 'Audit']) {
      expect(within(nav).getByRole('link', { name: label })).toBeInTheDocument();
    }
    // Cloudflare-style group headings organize the nav.
    expect(within(nav).getByText('Overview')).toBeInTheDocument();
    expect(within(nav).getByText('Fleet & compliance')).toBeInTheDocument();
    expect(within(nav).getByText('Revenue')).toBeInTheDocument();
  });

  it('opens the responsive nav drawer from the top-bar hamburger, traps focus, Esc closes + restores', async () => {
    render(<App />);
    await signIn();
    const hamburger = screen.getByRole('button', { name: 'Open navigation menu' });
    expect(hamburger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(hamburger);
    expect(hamburger).toHaveAttribute('aria-expanded', 'true');
    const nav = screen.getByRole('navigation', { name: 'Dashboard sections' });
    await waitFor(() => expect(nav.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(hamburger).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(document.activeElement).toBe(hamburger));
  });
});
