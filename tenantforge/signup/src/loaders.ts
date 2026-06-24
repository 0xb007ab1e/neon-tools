// Loaders for the two third-party scripts the signup flow needs, fetched from THEIR domains (the
// signup sub-app's CSP allow-lists js.stripe.com + challenges.cloudflare.com). Stripe requires
// Stripe.js to be loaded from js.stripe.com (never bundled), so there is no npm dependency here.

/** The slice of the Stripe.js API the flow uses (minimal hand-typed surface — no @stripe/stripe-js). */
export interface StripeElements {
  create(type: 'payment', options?: Record<string, unknown>): { mount(selector: string): void };
}
export interface Stripe {
  elements(options: { clientSecret: string; appearance?: Record<string, unknown> }): StripeElements;
  confirmSetup(opts: {
    elements: StripeElements;
    redirect: 'if_required';
  }): Promise<{ error?: { message?: string } }>;
}
type StripeCtor = (publishableKey: string) => Stripe;

/** Cloudflare Turnstile global (render returns a widget id; we read the token via callback). */
export interface Turnstile {
  render(
    container: string | HTMLElement,
    options: { sitekey: string; callback: (token: string) => void; 'error-callback'?: () => void },
  ): string;
  reset(widgetId?: string): void;
}

declare global {
  interface Window {
    Stripe?: StripeCtor;
    turnstile?: Turnstile;
  }
}

/** Inject a script tag once (idempotent by src) and resolve when it loads. */
function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing !== null) {
      resolve();
      return;
    }
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = (): void => resolve();
    el.onerror = (): void => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(el);
  });
}

/** Load Stripe.js and construct a Stripe instance with the publishable key. */
export async function loadStripe(publishableKey: string): Promise<Stripe> {
  await loadScript('https://js.stripe.com/v3/');
  if (window.Stripe === undefined) throw new Error('Stripe.js failed to initialize');
  return window.Stripe(publishableKey);
}

/** Load the Cloudflare Turnstile widget script. */
export async function loadTurnstile(): Promise<Turnstile> {
  await loadScript('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
  if (window.turnstile === undefined) throw new Error('Turnstile failed to initialize');
  return window.turnstile;
}
