import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { resetCsrf } from '../src/api';

// Mock Stripe.js loading: the real loader injects a <script> from js.stripe.com, which jsdom can't
// fetch. We return a fake Stripe whose Elements just records a mount, and confirmSetup succeeds.
const mountedSelectors: string[] = [];
vi.mock('../src/loaders', () => ({
  loadStripe: vi.fn(async () => ({
    elements: () => ({
      create: () => ({
        mount: (sel: string) => {
          mountedSelectors.push(sel);
        },
      }),
    }),
    confirmSetup: async () => ({}),
  })),
}));

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const noBody = (status: number): Response => new Response(null, { status });

const me = {
  id: 't1',
  slug: 'acme',
  region: 'aws-us-east-1',
  status: 'active',
  createdAt: '2026-01-02T00:00:00.000Z',
  planPriceUsd: 49,
};
const usage = {
  tenantId: 't1',
  period: { from: '2026-06-01T00:00:00.000Z', to: '2026-06-24T00:00:00.000Z' },
  consumption: {
    computeTimeSeconds: 3661,
    activeTimeSeconds: 100,
    writtenDataBytes: 2048,
    syntheticStorageBytes: 1048576,
  },
};
const invoices = [
  {
    tenantId: 't1',
    periodStart: '2026-06-01T00:00:00.000Z',
    periodEnd: '2026-06-24T00:00:00.000Z',
    currency: 'usd',
    generatedAt: '2026-06-24T00:00:00.000Z',
    lineItems: [
      {
        description: 'Base plan fee',
        quantity: 1,
        unit: 'period',
        unitPriceUsd: 49,
        amountUsd: 49,
      },
    ],
    totalUsd: 49,
  },
];
const charges = [
  {
    event: 'tenant.charged',
    at: '2026-06-20T00:00:00.000Z',
    outcome: 'ok',
    tenantId: 't1',
    context: { amountMinor: 4900, currency: 'usd', status: 'succeeded' },
  },
];
const receipts = [
  {
    event: 'tenant.notified',
    at: '2026-06-20T00:01:00.000Z',
    outcome: 'ok',
    tenantId: 't1',
    context: { kind: 'charge', reference: 'ch_1', status: 'queued' },
  },
];
const planView = { current: 49, available: [{ id: 'pro', priceUsd: 99 }] };
const planPreview = {
  tenantId: 't1',
  oldPriceUsd: 49,
  newPriceUsd: 99,
  period: { from: '2026-06-01T00:00:00.000Z', to: '2026-06-30T00:00:00.000Z' },
  proratedDeltaMinor: 2500,
};

/** Whether the (mocked) server advertises + mounts the destructive endpoints. */
let destructive = false;
/** When set, POST /api/session returns 401 (simulate a rejected login). */
let loginFails = false;
/** When set, the payment setup-intent fails (simulate no gateway configured). */
let paymentSetupFails = false;
/** The (mocked) server login mode advertised on /api/config. */
let authMode: 'oidc' | 'token' = 'token';
/** Capture the headers sent on the most recent plan-change POST (to assert CSRF + idempotency). */
let lastChangeHeaders: Headers | null = null;
/** Capture the body of the most recent POST /api/session (to assert {code,state} vs {token}). */
let lastSessionBody: unknown = null;

beforeEach(() => {
  resetCsrf();
  destructive = false;
  loginFails = false;
  paymentSetupFails = false;
  authMode = 'token';
  lastChangeHeaders = null;
  lastSessionBody = null;
  mountedSelectors.length = 0;
  window.location.hash = '';
  // Reset the query (the OIDC callback reads ?code&state) — jsdom honors history.replaceState.
  window.history.replaceState(null, '', '/portal/');
  document.documentElement.removeAttribute('data-theme');
  let authed = false;
  let erasurePending: unknown = null;

  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const features = { destructiveActions: destructive };

      if (url.endsWith('/api/config'))
        return Promise.resolve(
          json({ publishableKey: 'pk_test_123', features, auth: { mode: authMode } }),
        );
      if (url.endsWith('/api/login/start'))
        return Promise.resolve(json({ authorizeUrl: 'https://idp.example.com/authorize?state=s' }));
      if (url.endsWith('/api/session') && method === 'POST') {
        lastSessionBody = init?.body !== undefined ? JSON.parse(String(init.body)) : null;
        if (loginFails) return Promise.resolve(json({ error: 'login failed' }, 401));
        authed = true;
        return Promise.resolve(json({ tenantId: 't1', features }));
      }
      if (url.endsWith('/api/session') && method === 'DELETE') {
        authed = false;
        return Promise.resolve(noBody(204));
      }
      if (url.endsWith('/api/session'))
        return Promise.resolve(authed ? json({ tenantId: 't1', features }) : json({}, 401));
      if (url.endsWith('/api/csrf'))
        return Promise.resolve(authed ? json({ csrfToken: 'csrf-xyz' }) : json({}, 401));

      if (url.endsWith('/api/me')) return Promise.resolve(json(me));
      if (url.endsWith('/api/usage')) return Promise.resolve(json(usage));
      if (url.endsWith('/api/invoices')) return Promise.resolve(json({ invoices }));
      if (url.endsWith('/api/charges')) return Promise.resolve(json({ charges }));
      if (url.endsWith('/api/refunds')) return Promise.resolve(json({ refunds: [] }));
      if (url.endsWith('/api/receipts')) return Promise.resolve(json({ receipts }));
      if (url.endsWith('/api/credit-balance'))
        return Promise.resolve(json({ balanceMinor: 500, currency: 'usd' }));
      if (url.endsWith('/api/plan/preview')) return Promise.resolve(json(planPreview));
      if (url.endsWith('/api/plan/change')) {
        lastChangeHeaders = new Headers(init?.headers);
        return Promise.resolve(
          json({ ...planPreview, settlement: 'charged', settlementId: 'ch_2' }),
        );
      }
      if (url.endsWith('/api/plan')) return Promise.resolve(json(planView));
      if (url.endsWith('/api/payment-method/setup-intent'))
        return Promise.resolve(
          paymentSetupFails
            ? json({ error: 'no billing customer' }, 409)
            : json({ clientSecret: 'cs_1', setupIntentId: 'si_1', publishableKey: 'pk_test_123' }),
        );
      if (url.endsWith('/api/payment-method/set-default'))
        return Promise.resolve(json({ tenantId: 't1', hasDefault: true, setupIntentId: 'si_1' }));

      // Destructive endpoints: 404 when the flag is off (the SPA must not show their buttons).
      if (url.endsWith('/api/step-up'))
        return Promise.resolve(destructive ? noBody(204) : json({ error: 'not found' }, 404));
      if (url.endsWith('/api/cancel'))
        return Promise.resolve(
          destructive
            ? json({
                tenantId: 't1',
                status: 'offboarding',
                reversibleUntil: '2026-08-01T00:00:00.000Z',
              })
            : json({ error: 'not found' }, 404),
        );
      if (url.endsWith('/api/data-export'))
        return Promise.resolve(
          destructive ? json({ location: 's3://exports/t1.tar', bytes: 4096 }) : json({}, 404),
        );
      if (url.endsWith('/api/erasure/cancel')) {
        erasurePending = null;
        return Promise.resolve(destructive ? json({ cancelled: true }) : json({}, 404));
      }
      if (url.endsWith('/api/erasure') && method === 'POST') {
        erasurePending = {
          requestedAt: '2026-06-24T00:00:00.000Z',
          executeAt: '2026-06-26T00:00:00.000Z',
          status: 'pending',
        };
        return Promise.resolve(destructive ? json(erasurePending) : json({}, 404));
      }
      if (url.endsWith('/api/erasure'))
        return Promise.resolve(destructive ? json({ pending: erasurePending }) : json({}, 404));

      return Promise.resolve(json({ error: 'not found' }, 404));
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Sign in via the dev/token form (token mode — the default for the view tests) and land on Overview. */
const signIn = async (): Promise<void> => {
  fireEvent.change(await screen.findByLabelText(/Portal token/), { target: { value: 'tok-a' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByRole('heading', { level: 1, name: 'Overview' });
};

describe('portal App — auth', () => {
  it('token mode: shows the token form when unauthenticated, no a11y violations', async () => {
    const { container } = render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(await screen.findByLabelText(/Portal token/)).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('token mode: posts {token} (never a code) and lands on Overview', async () => {
    render(<App />);
    await signIn();
    expect(lastSessionBody).toEqual({ token: 'tok-a' });
  });

  it('oidc mode: shows the IdP button and starts the SERVER-driven flow (no client PKCE)', async () => {
    authMode = 'oidc';
    // jsdom's location.assign is non-configurable; replace window.location wholesale, then restore.
    const original = window.location;
    const assign = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, assign, hash: '', search: '', pathname: '/portal/' },
    });
    try {
      const { container } = render(<App />);
      const btn = await screen.findByRole('button', { name: /identity provider/i });
      // No dev-token field in oidc mode.
      expect(screen.queryByLabelText(/Portal token/)).toBeNull();
      expect((await axe(container)).violations).toEqual([]);
      fireEvent.click(btn);
      // The SPA asked the SERVER to start the flow and redirected to the returned authorize URL.
      await waitFor(() =>
        expect(assign).toHaveBeenCalledWith('https://idp.example.com/authorize?state=s'),
      );
      const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      expect(calls.some((c) => String(c[0]).endsWith('/api/login/start'))).toBe(true);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  it('oidc callback: reads code+state from the QUERY and posts {code,state} (never a token)', async () => {
    authMode = 'oidc';
    window.history.replaceState(null, '', '/portal/?code=auth-code-123&state=server-state');
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
    // The SPA exchanged code+state server-side; it never handled a raw token.
    expect(lastSessionBody).toEqual({ code: 'auth-code-123', state: 'server-state' });
    // The callback params were scrubbed from the URL (not left in history).
    expect(window.location.search).toBe('');
  });
});

describe('portal App — views', () => {
  it('renders the Overview account + usage, no a11y violations', async () => {
    const { container } = render(<App />);
    await signIn();
    expect(await screen.findByText('acme')).toBeInTheDocument();
    expect(await screen.findByText('aws-us-east-1')).toBeInTheDocument();
    expect(await screen.findByText('1h 1m')).toBeInTheDocument(); // 3661s compute
    expect((await axe(container)).violations).toEqual([]);
  });

  it('renders the Billing view (credit, invoices, charges, receipts), no a11y violations', async () => {
    const { container } = render(<App />);
    await signIn();
    fireEvent.click(await screen.findByRole('link', { name: 'Billing' }));
    expect(await screen.findByRole('heading', { name: 'Credit balance' })).toBeInTheDocument();
    expect(await screen.findByText('$5.00')).toBeInTheDocument();
    expect(await screen.findByText('Base plan fee')).toBeInTheDocument();
    // $49.00 appears both in the invoice caption total and the line-item amount cell.
    expect((await screen.findAllByText('$49.00')).length).toBeGreaterThan(0);
    expect(await screen.findByRole('heading', { name: 'Recent receipts' })).toBeInTheDocument();
    expect(await screen.findByText('ch_1')).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('previews then confirms a plan change, sending the CSRF + idempotency headers', async () => {
    render(<App />);
    await signIn();
    fireEvent.click(await screen.findByRole('link', { name: 'Plan' }));
    fireEvent.change(await screen.findByLabelText(/New plan price/), { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview change' }));
    // The preview is surfaced; then confirm applies it.
    expect(await screen.findByText(/You will be charged \$25\.00 now/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
    expect(await screen.findByText(/Plan updated; charged \$25\.00\./)).toBeInTheDocument();
    // CSRF header + idempotency key were sent on the change POST.
    expect(lastChangeHeaders?.get('X-TF-CSRF')).toBe('csrf-xyz');
    expect(lastChangeHeaders?.get('Idempotency-Key')).toBeTruthy();
  });

  it('mounts Stripe Elements and saves a card on the Payment view', async () => {
    render(<App />);
    await signIn();
    fireEvent.click(await screen.findByRole('link', { name: 'Payment method' }));
    await waitFor(() => expect(mountedSelectors).toContain('#payment-element'));
    const save = await screen.findByRole('button', { name: 'Save card' });
    await waitFor(() => expect(save).not.toBeDisabled());
    fireEvent.click(save);
    expect(
      await screen.findByText('Your default payment method has been updated.'),
    ).toBeInTheDocument();
  });
});

describe('portal App — error + lifecycle paths', () => {
  it('surfaces a rejected dev-token login (stays on the form)', async () => {
    loginFails = true;
    render(<App />);
    fireEvent.change(await screen.findByLabelText(/Portal token/), { target: { value: 'bad' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('login failed');
    // Still signed out (the form is still shown).
    expect(screen.getByLabelText(/Portal token/)).toBeInTheDocument();
  });

  it('signs out: clears the session and returns to the sign-in form', async () => {
    render(<App />);
    await signIn();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
  });

  it('payment view: surfaces a setup-intent failure (no gateway) without mounting Elements', async () => {
    paymentSetupFails = true;
    render(<App />);
    await signIn();
    fireEvent.click(await screen.findByRole('link', { name: 'Payment method' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no billing customer');
  });

  it('plan view: an out-of-range price is guarded client-side (no preview request)', async () => {
    render(<App />);
    await signIn();
    fireEvent.click(await screen.findByRole('link', { name: 'Plan' }));
    const input = await screen.findByLabelText(/New plan price/);
    fireEvent.change(input, { target: { value: '-5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview change' }));
    // No preview POST fired for a negative price.
    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.some((c) => String(c[0]).endsWith('/api/plan/preview'))).toBe(false);
  });

  it('plan view: cancelling the preview confirmation dismisses it', async () => {
    render(<App />);
    await signIn();
    fireEvent.click(await screen.findByRole('link', { name: 'Plan' }));
    fireEvent.change(await screen.findByLabelText(/New plan price/), { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview change' }));
    expect(await screen.findByRole('button', { name: 'Confirm change' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Confirm change' })).toBeNull(),
    );
  });

  it('closes a danger-zone modal with Escape (focus management)', async () => {
    destructive = true;
    render(<App />);
    await signIn();
    fireEvent.click(await screen.findByRole('link', { name: 'Danger zone' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel workspace…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm cancellation' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('portal App — flag-gated Danger zone', () => {
  it('hides the Danger zone when destructiveActions is OFF (no dead buttons)', async () => {
    destructive = false;
    render(<App />);
    await signIn();
    expect(screen.queryByRole('link', { name: 'Danger zone' })).toBeNull();
  });

  it('redirects away from #danger when the flag is off (graceful)', async () => {
    destructive = false;
    window.location.hash = '#/danger';
    render(<App />);
    await signIn();
    // Falls back to Overview rather than rendering a broken section.
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Danger zone' })).toBeNull();
  });

  it('shows the Danger zone + drives cancel/erasure/export when the flag is ON, no a11y violations', async () => {
    destructive = true;
    const { container } = render(<App />);
    await signIn();
    fireEvent.click(await screen.findByRole('link', { name: 'Danger zone' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Danger zone' }),
    ).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);

    // Data export.
    fireEvent.click(screen.getByRole('button', { name: 'Request data export' }));
    expect(await screen.findByText(/s3:\/\/exports\/t1\.tar/)).toBeInTheDocument();

    // Cancel: open the modal (focus trap), request a code, then confirm.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel workspace…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm cancellation' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Email me a code' }));
    fireEvent.change(await within(dialog).findByLabelText('Confirmation code'), {
      target: { value: '123456' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel workspace' }));
    expect(await screen.findByText(/Workspace cancelled\./)).toBeInTheDocument();
  });

  it('schedules then cancels an erasure within the undo window', async () => {
    destructive = true;
    render(<App />);
    await signIn();
    fireEvent.click(await screen.findByRole('link', { name: 'Danger zone' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Erase workspace…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Permanently erase workspace' });
    fireEvent.change(within(dialog).getByLabelText('Type ERASE to confirm'), {
      target: { value: 'ERASE' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Email me a code' }));
    fireEvent.change(await within(dialog).findByLabelText('Confirmation code'), {
      target: { value: '654321' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Schedule erasure' }));
    // The pending erasure status (undo window) is shown with a cancel action.
    expect(await screen.findByText(/Erasure scheduled\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel scheduled erasure' }));
    await waitFor(() => expect(screen.queryByText(/Erasure scheduled\./)).not.toBeInTheDocument());
  });
});

// Every screen AND every modal carries an automated axe pass (master §4 / topic-accessibility): the
// auth + Overview + Billing + Danger-zone screens are covered above; this block fills the gaps —
// the Plan and Payment-method screens, and each Danger-zone modal in its OPEN (dialog) state, where
// the focus-trapped confirmation flow lives. axe catches ~30–40%; the manual keyboard + NVDA/VoiceOver
// pass (docs/a11y/portal-manual-test-plan.md) is the human complement.
describe('portal App — a11y coverage of every screen + modal (axe)', () => {
  it('Plan screen has no a11y violations (form + preview confirm-box)', async () => {
    const { container } = render(<App />);
    await signIn();
    fireEvent.click(await screen.findByRole('link', { name: 'Plan' }));
    await screen.findByLabelText(/New plan price/);
    expect((await axe(container)).violations).toEqual([]);
    // Also axe the open confirm-box state (the prorated-charge confirmation).
    fireEvent.change(await screen.findByLabelText(/New plan price/), { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview change' }));
    await screen.findByRole('button', { name: 'Confirm change' });
    expect((await axe(container)).violations).toEqual([]);
  });

  it('Payment method screen has no a11y violations (Stripe Elements mounted)', async () => {
    const { container } = render(<App />);
    await signIn();
    fireEvent.click(await screen.findByRole('link', { name: 'Payment method' }));
    await screen.findByRole('button', { name: 'Save card' });
    expect((await axe(container)).violations).toEqual([]);
  });

  it('Payment method screen has no a11y violations in the error state (no gateway)', async () => {
    paymentSetupFails = true;
    const { container } = render(<App />);
    await signIn();
    fireEvent.click(await screen.findByRole('link', { name: 'Payment method' }));
    await screen.findByRole('alert');
    expect((await axe(container)).violations).toEqual([]);
  });

  it('Cancel modal (open dialog) has no a11y violations — code-entry step', async () => {
    destructive = true;
    const { container } = render(<App />);
    await signIn();
    fireEvent.click(await screen.findByRole('link', { name: 'Danger zone' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel workspace…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm cancellation' });
    // Initial (request-code) state.
    expect((await axe(container)).violations).toEqual([]);
    // After requesting the code, the code-entry form is shown — axe it too.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Email me a code' }));
    await within(dialog).findByLabelText('Confirmation code');
    expect((await axe(container)).violations).toEqual([]);
  });

  it('Erasure modal (open dialog) has no a11y violations — typed-confirm + code-entry steps', async () => {
    destructive = true;
    const { container } = render(<App />);
    await signIn();
    fireEvent.click(await screen.findByRole('link', { name: 'Danger zone' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Erase workspace…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Permanently erase workspace' });
    // Typed-confirm state.
    expect((await axe(container)).violations).toEqual([]);
    // Code-entry state (after typing ERASE + requesting a code).
    fireEvent.change(within(dialog).getByLabelText('Type ERASE to confirm'), {
      target: { value: 'ERASE' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Email me a code' }));
    await within(dialog).findByLabelText('Confirmation code');
    expect((await axe(container)).violations).toEqual([]);
  });

  it('Danger zone with a pending erasure (undo-window status) has no a11y violations', async () => {
    destructive = true;
    const { container } = render(<App />);
    await signIn();
    fireEvent.click(await screen.findByRole('link', { name: 'Danger zone' }));
    // Schedule an erasure so the pending-status confirm-box renders, then axe that state.
    fireEvent.click(await screen.findByRole('button', { name: 'Erase workspace…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Permanently erase workspace' });
    fireEvent.change(within(dialog).getByLabelText('Type ERASE to confirm'), {
      target: { value: 'ERASE' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Email me a code' }));
    fireEvent.change(await within(dialog).findByLabelText('Confirmation code'), {
      target: { value: '654321' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Schedule erasure' }));
    await screen.findByText(/Erasure scheduled\./);
    expect((await axe(container)).violations).toEqual([]);
  });
});
