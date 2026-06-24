import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type SignupConfig } from './api.js';
import { loadStripe, loadTurnstile, type Stripe, type StripeElements } from './loaders.js';

type Step = 'email' | 'verify' | 'details' | 'provisioning' | 'done';

const STEP_LABELS: Record<Step, string> = {
  email: 'Email',
  verify: 'Verify',
  details: 'Workspace & payment',
  provisioning: 'Provisioning',
  done: 'Done',
};

/** Regions offered to the customer (data residency). The server re-validates against its allow-list. */
const REGIONS: { id: string; label: string }[] = [
  { id: 'aws-us-east-1', label: 'US East (N. Virginia)' },
  { id: 'aws-us-west-2', label: 'US West (Oregon)' },
  { id: 'aws-eu-central-1', label: 'EU (Frankfurt)' },
  { id: 'aws-eu-west-1', label: 'EU (Ireland)' },
  { id: 'aws-ap-southeast-1', label: 'Asia Pacific (Singapore)' },
];

/** The self-serve signup flow: email + captcha → verify → workspace + payment → provisioning → done. */
export function App(): React.ReactElement {
  const [step, setStep] = useState<Step>('email');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cfg, setCfg] = useState<SignupConfig | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // email step
  const [email, setEmail] = useState('');
  const [captchaToken, setCaptchaToken] = useState('');
  // verify step
  const [code, setCode] = useState('');
  // details step
  const [slug, setSlug] = useState('');
  const [region, setRegion] = useState(REGIONS[0]!.id);
  const [planId, setPlanId] = useState('');
  const stripeRef = useRef<Stripe | null>(null);
  const elementsRef = useRef<StripeElements | null>(null);
  // done step
  const [connectionUri, setConnectionUri] = useState<string | undefined>(undefined);

  // Load public config once.
  useEffect(() => {
    api.config().then(setCfg, (e: unknown) => setError(String(e)));
  }, []);

  // Move focus to the step heading on each transition (a11y: announce + orient).
  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  // Render the Turnstile widget on the email step once config is available.
  useEffect(() => {
    if (step !== 'email' || cfg === null) return;
    let widgetId: string | undefined;
    let cancelled = false;
    loadTurnstile().then(
      (ts) => {
        if (cancelled) return;
        widgetId = ts.render('#captcha', {
          sitekey: cfg.captchaSiteKey,
          callback: (t) => setCaptchaToken(t),
          'error-callback': () => setCaptchaToken(''),
        });
      },
      (e: unknown) => setError(String(e)),
    );
    return () => {
      cancelled = true;
      if (widgetId !== undefined) window.turnstile?.reset(widgetId);
    };
  }, [step, cfg]);

  // On the details step: open the PSP setup intent and mount the Stripe Payment Element.
  useEffect(() => {
    if (step !== 'details') return;
    let cancelled = false;
    setBusy(true);
    api
      .paymentIntent()
      .then(async (setup) => {
        const stripe = await loadStripe(setup.publishableKey);
        if (cancelled) return;
        const elements = stripe.elements({ clientSecret: setup.clientSecret });
        elements.create('payment').mount('#payment-element');
        stripeRef.current = stripe;
        elementsRef.current = elements;
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [step]);

  const guard = useCallback(async (fn: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const submitEmail = (e: React.FormEvent): void => {
    e.preventDefault();
    void guard(async () => {
      await api.start(email, captchaToken);
      setStep('verify');
    });
  };

  const submitCode = (e: React.FormEvent): void => {
    e.preventDefault();
    void guard(async () => {
      await api.verifyEmail(code);
      setStep('details');
    });
  };

  const submitDetails = (e: React.FormEvent): void => {
    e.preventDefault();
    void guard(async () => {
      const stripe = stripeRef.current;
      const elements = elementsRef.current;
      if (stripe === null || elements === null) throw new Error('payment form not ready');
      const { error: stripeError } = await stripe.confirmSetup({
        elements,
        redirect: 'if_required',
      });
      if (stripeError !== undefined)
        throw new Error(stripeError.message ?? 'card could not be saved');
      await api.complete({ slug, region, ...(planId !== '' ? { planId } : {}) });
      setStep('provisioning');
    });
  };

  // Poll provisioning status until active.
  useEffect(() => {
    if (step !== 'provisioning') return;
    let stop = false;
    const tick = (): void => {
      api.status().then(
        (s) => {
          if (stop) return;
          if (s.status === 'active') {
            setConnectionUri(s.connectionUri);
            setStep('done');
          } else if (s.status === 'failed') {
            setError('Provisioning failed. Please contact support.');
          } else {
            setTimeout(tick, 3000);
          }
        },
        (e: unknown) => !stop && setError(String(e)),
      );
    };
    tick();
    return () => {
      stop = true;
    };
  }, [step]);

  return (
    <main>
      <a className="skip-link" href="#main-heading">
        Skip to content
      </a>
      <div className="card">
        <ol className="steps">
          {(Object.keys(STEP_LABELS) as Step[]).map((s) => (
            <li key={s} aria-current={s === step ? 'step' : undefined}>
              {STEP_LABELS[s]}
            </li>
          ))}
        </ol>

        <h1 id="main-heading" ref={headingRef} tabIndex={-1}>
          {step === 'email' && 'Create your workspace'}
          {step === 'verify' && 'Check your email'}
          {step === 'details' && 'Workspace & payment'}
          {step === 'provisioning' && 'Setting up your workspace…'}
          {step === 'done' && 'Your workspace is ready'}
        </h1>

        {error !== null && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}

        {step === 'email' && (
          <form onSubmit={submitEmail}>
            <p className="lede">Enter your email and confirm you’re human to get started.</p>
            <label htmlFor="email">Email address</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <div id="captcha" />
            <button type="submit" disabled={busy || captchaToken === '' || email === ''}>
              {busy && <span className="spinner" aria-hidden="true" />}
              Continue
            </button>
          </form>
        )}

        {step === 'verify' && (
          <form onSubmit={submitCode}>
            <p className="lede">
              We emailed a 6-digit code to <strong>{email}</strong>. Enter it below.
            </p>
            <label htmlFor="code">
              Verification code <span className="hint">(expires in 15 minutes)</span>
            </label>
            <input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <button type="submit" disabled={busy || code === ''}>
              {busy && <span className="spinner" aria-hidden="true" />}
              Verify
            </button>
          </form>
        )}

        {step === 'details' && (
          <form onSubmit={submitDetails}>
            <p className="lede">Choose your workspace and add a payment method.</p>
            <label htmlFor="slug">
              Workspace name <span className="hint">(lowercase letters, numbers, hyphens)</span>
            </label>
            <input
              id="slug"
              required
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
            />
            <label htmlFor="region">Region</label>
            <select id="region" value={region} onChange={(e) => setRegion(e.target.value)}>
              {REGIONS.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
            <label htmlFor="plan">
              Plan <span className="hint">(optional)</span>
            </label>
            <select id="plan" value={planId} onChange={(e) => setPlanId(e.target.value)}>
              <option value="">Default</option>
              <option value="starter">Starter</option>
              <option value="pro">Pro</option>
            </select>
            <label htmlFor="payment-element">Payment method</label>
            <div id="payment-element" />
            <button type="submit" disabled={busy || slug === ''}>
              {busy && <span className="spinner" aria-hidden="true" />}
              Create workspace
            </button>
          </form>
        )}

        {step === 'provisioning' && (
          <p className="status" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            Creating your database… this can take up to a minute.
          </p>
        )}

        {step === 'done' && (
          <div>
            <p className="lede">
              Your workspace <strong>{slug}</strong> is live. We’ve emailed you a sign-in link.
            </p>
            {connectionUri !== undefined && (
              <>
                <label htmlFor="conn">Connection string (shown once — store it securely)</label>
                <p id="conn" className="reveal">
                  {connectionUri}
                </p>
              </>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
