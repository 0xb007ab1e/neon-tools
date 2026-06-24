// Loader for Stripe.js, fetched from js.stripe.com (the portal sub-app's CSP allow-lists it). Stripe
// requires Stripe.js to be loaded from their domain (never bundled) so card data (PAN) never touches
// our server — Stripe Elements collects + confirms it client-side. There is no npm dependency here.

/** The slice of the Stripe.js API the payment-method flow uses (minimal hand-typed surface). */
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

declare global {
  interface Window {
    Stripe?: StripeCtor;
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
