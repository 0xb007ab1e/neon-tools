import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';

// Mock the third-party loaders: the real ones inject <script> from js.stripe.com /
// challenges.cloudflare.com, which jsdom can't fetch. We provide fakes whose behavior the tests
// drive via the mutable knobs below.

/** When set, loadStripe rejects (simulate Stripe.js failing to load/init). */
let stripeLoadFails = false;
/** When set, confirmSetup returns a Stripe error object. */
let confirmSetupError: { message?: string } | undefined;
/** When set, loadTurnstile rejects (simulate the captcha script failing). */
let turnstileLoadFails = false;
/** Records the selectors the (fake) Payment Element mounted to. */
const mountedSelectors: string[] = [];
/** Captures the turnstile render options so a test can fire the success/error callbacks. */
let turnstileRenderOpts: {
  sitekey: string;
  callback: (t: string) => void;
  'error-callback'?: () => void;
} | null = null;
const turnstileReset = vi.fn();

vi.mock('../src/loaders', () => ({
  loadStripe: vi.fn(() => {
    if (stripeLoadFails) return Promise.reject(new Error('Stripe.js failed to initialize'));
    return Promise.resolve({
      elements: () => ({
        create: () => ({
          mount: (sel: string) => {
            mountedSelectors.push(sel);
          },
        }),
      }),
      confirmSetup: () => Promise.resolve(confirmSetupError ? { error: confirmSetupError } : {}),
    });
  }),
  loadTurnstile: vi.fn(() => {
    if (turnstileLoadFails) return Promise.reject(new Error('Turnstile failed to initialize'));
    return Promise.resolve({
      render: (_container: string, opts: typeof turnstileRenderOpts) => {
        turnstileRenderOpts = opts;
        return 'widget-1';
      },
      reset: turnstileReset,
    });
  }),
}));

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const noBody = (status: number): Response => new Response(null, { status });

/** Coerce a fetch input (string | URL | Request) to its URL string without tripping no-base-to-string. */
const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

const cfg = { publishableKey: 'pk_test', captchaSiteKey: 'cap_site' };

// Mutable status sequence the /status poller walks through.
let statusQueue: { status: string; slug?: string; connectionUri?: string }[];
/** When set, GET /config 500s (simulate config load failure). */
let configFails = false;
/** When set, the payment-intent setup 409s (simulate no gateway). */
let paymentIntentFails = false;

beforeEach(() => {
  stripeLoadFails = false;
  confirmSetupError = undefined;
  turnstileLoadFails = false;
  configFails = false;
  paymentIntentFails = false;
  mountedSelectors.length = 0;
  turnstileRenderOpts = null;
  turnstileReset.mockClear();
  statusQueue = [{ status: 'active', slug: 'acme', connectionUri: 'postgres://secret-once' }];

  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = urlOf(input);
      const method = init?.method ?? 'GET';

      if (url.endsWith('/signup/api/config'))
        return Promise.resolve(configFails ? json({ error: 'boom' }, 500) : json(cfg));
      if (url.endsWith('/signup/api/start')) return Promise.resolve(json({ ok: true }));
      if (url.endsWith('/signup/api/verify-email')) return Promise.resolve(noBody(204));
      if (url.endsWith('/signup/api/payment-intent') && method === 'POST')
        return Promise.resolve(
          paymentIntentFails
            ? json({ error: 'no billing gateway' }, 409)
            : json({ clientSecret: 'cs_1', setupIntentId: 'si_1', publishableKey: 'pk_test' }),
        );
      if (url.endsWith('/signup/api/complete'))
        return Promise.resolve(json({ status: 'provisioning' }));
      if (url.endsWith('/signup/api/status')) {
        const next = statusQueue.length > 1 ? statusQueue.shift()! : statusQueue[0]!;
        return Promise.resolve(json(next));
      }
      return Promise.resolve(json({ error: `unexpected ${method} ${url}` }, 500));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Render the App and wait for the initial config load to settle (Turnstile rendered). */
async function renderAndLoadConfig(): Promise<ReturnType<typeof render>> {
  const utils = render(<App />);
  await waitFor(() => expect(turnstileRenderOpts).not.toBeNull());
  return utils;
}

/** Drive the email step to completion → lands on the verify step. */
async function advanceToVerify(): Promise<void> {
  fireEvent.change(screen.getByLabelText('Email address'), {
    target: { value: 'user@example.com' },
  });
  turnstileRenderOpts!.callback('captcha-token'); // captcha solved
  await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByRole('heading', { name: 'Check your email' });
}

/** Drive the verify step to completion → lands on the details step (payment mounted). */
async function advanceToDetails(): Promise<void> {
  await advanceToVerify();
  fireEvent.change(screen.getByLabelText(/Verification code/), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
  await screen.findByRole('heading', { name: 'Workspace & payment' });
  await waitFor(() => expect(mountedSelectors).toContain('#payment-element'));
}

describe('signup App — initial render & config', () => {
  it('renders the email step with the step rail and loads public config (renders Turnstile)', async () => {
    await renderAndLoadConfig();

    expect(screen.getByRole('heading', { name: 'Create your workspace' })).toBeInTheDocument();
    // Step rail labels.
    for (const label of ['Email', 'Verify', 'Workspace & payment', 'Provisioning', 'Done']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // Turnstile got the configured site key.
    expect(turnstileRenderOpts!.sitekey).toBe('cap_site');
  });

  it('shows an error alert if public config fails to load', async () => {
    configFails = true;
    render(<App />);

    // The config-load handler uses `setError(String(e))`, so the thrown Error is stringified
    // ("Error: <message>") — here the server's safe {error} body propagates through `call`.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/boom/);
  });

  it('shows an error alert if the captcha script fails to load', async () => {
    turnstileLoadFails = true;
    render(<App />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Turnstile failed to initialize/);
  });

  it('Continue is disabled until both an email and a captcha token are present', async () => {
    await renderAndLoadConfig();
    const btn = screen.getByRole('button', { name: 'Continue' });
    expect(btn).toBeDisabled(); // no email, no token

    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'a@b.com' } });
    expect(btn).toBeDisabled(); // still no token

    turnstileRenderOpts!.callback('tok');
    await waitFor(() => expect(btn).toBeEnabled());

    // The error-callback clears the token, re-disabling the button.
    turnstileRenderOpts!['error-callback']!();
    await waitFor(() => expect(btn).toBeDisabled());
  });
});

describe('signup App — happy-path funnel', () => {
  it('email → verify → details → provisioning → done, revealing the connection string once', async () => {
    await renderAndLoadConfig();
    await advanceToDetails();

    // Fill the details form and submit (confirmSetup succeeds, then complete → provisioning).
    fireEvent.change(screen.getByLabelText(/Workspace name/), { target: { value: 'acme' } });
    fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'aws-eu-central-1' } });
    fireEvent.change(screen.getByLabelText(/Plan/), { target: { value: 'pro' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));

    await screen.findByRole('heading', { name: 'Setting up your workspace…' });
    // Poller sees 'active' → done, connection string revealed once.
    await screen.findByRole('heading', { name: 'Your workspace is ready' });
    expect(screen.getByText('postgres://secret-once')).toBeInTheDocument();
    expect(screen.getByText('acme')).toBeInTheDocument();
  });

  it('details step with the default (empty) plan omits planId in the complete payload', async () => {
    const fetchSpy = globalThis.fetch as unknown as {
      mock: { calls: [RequestInfo | URL, RequestInit?][] };
    };
    await renderAndLoadConfig();
    await advanceToDetails();

    fireEvent.change(screen.getByLabelText(/Workspace name/), { target: { value: 'acme' } });
    // leave Plan at "Default" (value '')
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));
    await screen.findByRole('heading', { name: 'Setting up your workspace…' });

    const completeCall = fetchSpy.mock.calls.find((c) =>
      urlOf(c[0]).endsWith('/signup/api/complete'),
    )!;
    const rawBody = completeCall[1]?.body;
    const body = JSON.parse(typeof rawBody === 'string' ? rawBody : '') as Record<string, unknown>;
    expect(body).toEqual({ slug: 'acme', region: 'aws-us-east-1' });
    expect(body).not.toHaveProperty('planId');
  });

  it('done step without a connectionUri does not render the reveal block', async () => {
    statusQueue = [{ status: 'active', slug: 'acme' }]; // no connectionUri
    await renderAndLoadConfig();
    await advanceToDetails();
    fireEvent.change(screen.getByLabelText(/Workspace name/), { target: { value: 'acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));

    await screen.findByRole('heading', { name: 'Your workspace is ready' });
    expect(screen.queryByText(/Connection string \(shown once/)).not.toBeInTheDocument();
  });
});

describe('signup App — verify & details error paths', () => {
  it('surfaces a server error from the email step (start) and stays on the email step', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.endsWith('/signup/api/config')) return Promise.resolve(json(cfg));
        if (url.endsWith('/signup/api/start'))
          return Promise.resolve(json({ error: 'captcha rejected' }, 400));
        return Promise.resolve(json({}, 500));
      },
    );
    await renderAndLoadConfig();
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'a@b.com' } });
    turnstileRenderOpts!.callback('tok');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/captcha rejected/);
    expect(screen.getByRole('heading', { name: 'Create your workspace' })).toBeInTheDocument();
  });

  it('shows an error if the payment setup-intent fails on entering the details step', async () => {
    paymentIntentFails = true;
    await renderAndLoadConfig();
    await advanceToVerify();
    fireEvent.change(screen.getByLabelText(/Verification code/), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

    await screen.findByRole('heading', { name: 'Workspace & payment' });
    expect((await screen.findByRole('alert')).textContent).toMatch(/no billing gateway/);
  });

  it('shows an error if Stripe.js fails to load on the details step', async () => {
    stripeLoadFails = true;
    await renderAndLoadConfig();
    await advanceToVerify();
    fireEvent.change(screen.getByLabelText(/Verification code/), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

    await screen.findByRole('heading', { name: 'Workspace & payment' });
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Stripe.js failed to initialize/,
    );
  });

  it('blocks submit with "payment form not ready" when Stripe never mounted', async () => {
    stripeLoadFails = true; // payment element never mounts → stripeRef stays null
    await renderAndLoadConfig();
    await advanceToVerify();
    fireEvent.change(screen.getByLabelText(/Verification code/), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await screen.findByRole('heading', { name: 'Workspace & payment' });
    // Clear the load-failure alert by filling + submitting; the guard runs and throws not-ready.
    fireEvent.change(screen.getByLabelText(/Workspace name/), { target: { value: 'acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/payment form not ready/),
    );
  });

  it('surfaces the Stripe confirmSetup error message and does not advance to provisioning', async () => {
    confirmSetupError = { message: 'card declined' };
    await renderAndLoadConfig();
    await advanceToDetails();
    fireEvent.change(screen.getByLabelText(/Workspace name/), { target: { value: 'acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/card declined/));
    expect(
      screen.queryByRole('heading', { name: 'Setting up your workspace…' }),
    ).not.toBeInTheDocument();
  });

  it('falls back to a default message when the Stripe error has no message', async () => {
    confirmSetupError = {}; // no message
    await renderAndLoadConfig();
    await advanceToDetails();
    fireEvent.change(screen.getByLabelText(/Workspace name/), { target: { value: 'acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/card could not be saved/),
    );
  });
});

describe('signup App — provisioning poller', () => {
  it('retries on a non-terminal status then resolves to done when it turns active', async () => {
    vi.useFakeTimers();
    try {
      statusQueue = [
        { status: 'provisioning' },
        { status: 'active', slug: 'acme', connectionUri: 'uri-2' },
      ];
      const utils = render(<App />);
      await vi.waitFor(() => expect(turnstileRenderOpts).not.toBeNull());
      // Drive to provisioning quickly (real timers would be slow; advance manually).
      fireEvent.change(utils.getByLabelText('Email address'), {
        target: { value: 'a@b.com' },
      });
      turnstileRenderOpts!.callback('tok');
      await vi.waitFor(() => expect(utils.getByRole('button', { name: 'Continue' })).toBeEnabled());
      fireEvent.click(utils.getByRole('button', { name: 'Continue' }));
      await vi.waitFor(() => utils.getByRole('heading', { name: 'Check your email' }));
      fireEvent.change(utils.getByLabelText(/Verification code/), { target: { value: '1' } });
      fireEvent.click(utils.getByRole('button', { name: 'Verify' }));
      await vi.waitFor(() => utils.getByRole('heading', { name: 'Workspace & payment' }));
      await vi.waitFor(() => expect(mountedSelectors).toContain('#payment-element'));
      fireEvent.change(utils.getByLabelText(/Workspace name/), { target: { value: 'acme' } });
      fireEvent.click(utils.getByRole('button', { name: 'Create workspace' }));
      await vi.waitFor(() => utils.getByRole('heading', { name: 'Setting up your workspace…' }));

      // First poll → 'provisioning' schedules a 3s retry; advance the clock.
      await vi.advanceTimersByTimeAsync(3000);
      await vi.waitFor(() => utils.getByRole('heading', { name: 'Your workspace is ready' }));
      expect(utils.getByText('uri-2')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a support message when provisioning reports failed', async () => {
    statusQueue = [{ status: 'failed' }];
    await renderAndLoadConfig();
    await advanceToDetails();
    fireEvent.change(screen.getByLabelText(/Workspace name/), { target: { value: 'acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));

    await screen.findByRole('heading', { name: 'Setting up your workspace…' });
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/Provisioning failed/),
    );
  });

  it('surfaces a network error from the status poller', async () => {
    await renderAndLoadConfig();
    await advanceToDetails();
    // Make /status reject once we are about to poll.
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.endsWith('/signup/api/complete'))
          return Promise.resolve(json({ status: 'provisioning' }));
        if (url.endsWith('/signup/api/status'))
          return Promise.reject(new TypeError('Failed to fetch'));
        return Promise.resolve(json({}, 500));
      },
    );
    fireEvent.change(screen.getByLabelText(/Workspace name/), { target: { value: 'acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));

    await screen.findByRole('heading', { name: 'Setting up your workspace…' });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Failed to fetch/));
  });
});

// Automated axe pass on each rendered step (master §4 / topic-accessibility). axe catches ~30–40%;
// the manual keyboard + screen-reader passes are tracked separately.
describe('signup App — a11y (axe) of each step', () => {
  it('email step has no automated a11y violations', async () => {
    const { container } = await renderAndLoadConfig();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('verify step has no automated a11y violations', async () => {
    const { container } = await renderAndLoadConfig();
    await advanceToVerify();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('details step has no automated a11y violations', async () => {
    const { container } = await renderAndLoadConfig();
    await advanceToDetails();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('done step has no automated a11y violations', async () => {
    const { container } = await renderAndLoadConfig();
    await advanceToDetails();
    fireEvent.change(screen.getByLabelText(/Workspace name/), { target: { value: 'acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));
    await screen.findByRole('heading', { name: 'Your workspace is ready' });
    expect((await axe(container)).violations).toEqual([]);
  });
});
