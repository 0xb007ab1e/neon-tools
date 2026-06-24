/** A request to create a PSP customer for a brand-new (not-yet-provisioned) signup. */
export interface CreateCustomerRequest {
  /** The customer's email (PII — never logged; used by the PSP for receipts). */
  email: string;
  /**
   * Idempotency key — the adapter MUST pass it to the PSP so a retried create does not make a
   * duplicate customer. Derive it deterministically from the signup (e.g. the signup-session id).
   */
  idempotencyKey: string;
  /** Optional non-sensitive key/value metadata to attach at the PSP (e.g. `{ signup_id }`). */
  metadata?: Record<string, string>;
}

/** The created PSP customer (no card data — safe to persist as `metadata.billingCustomerRef`). */
export interface CreateCustomerResult {
  /** The PSP customer reference (e.g. a Stripe `cus_…` id). */
  customerRef: string;
  /** The provider that created it (e.g. `stripe`). */
  provider: string;
}

/** A request to begin collecting (and saving) a payment method for later off-session charges. */
export interface CreateSetupIntentRequest {
  /** The PSP customer the payment method will be attached to (from {@link CreateCustomerResult}). */
  customerRef: string;
  /** Idempotency key — passed to the PSP so a retried setup does not create a duplicate intent. */
  idempotencyKey: string;
  /** Optional non-sensitive metadata to attach (e.g. `{ signup_id }`). */
  metadata?: Record<string, string>;
}

/**
 * A pending setup intent. The `clientSecret` is handed to the browser so the PSP's client SDK (e.g.
 * Stripe.js) can collect the card and confirm the intent **client-side** — card data never touches
 * this server. It is a short-lived, client-scoped secret (not a server credential), but still must
 * only travel over TLS and never be logged.
 */
export interface CreateSetupIntentResult {
  /** The PSP setup-intent id (used later to verify the payment method was saved). */
  setupIntentId: string;
  /** The client secret for the PSP client SDK to confirm the intent in the browser. */
  clientSecret: string;
  /** The provider (e.g. `stripe`). */
  provider: string;
}

/** Normalized state of a setup intent, read back server-side after the client confirms it. */
export interface SetupIntentState {
  /**
   * Normalized status: `succeeded` (a payment method was saved — safe to provision), `processing`
   * (settlement in flight), or `requires_action` (the customer must still complete a step, e.g. 3DS).
   */
  status: 'succeeded' | 'processing' | 'requires_action';
  /** The PSP customer the intent belongs to (cross-check against the signup's stored customer ref). */
  customerRef: string;
  /** The saved payment-method reference (present once `succeeded`); never card data. */
  paymentMethodRef?: string;
  /** The provider (e.g. `stripe`). */
  provider: string;
}

/**
 * Port: PSP **payment-method setup** for new signups — the seam that lets a customer save a payment
 * method *before* their tenant exists. Deliberately separate from {@link import('./payment-gateway.js').PaymentGateway}
 * (interface segregation): that port *charges* an existing customer; this one *onboards* one. An
 * adapter (e.g. Stripe) implements both independently. Treat the PSP as an untrusted, unreliable
 * upstream (`topic-api-consumption`): set timeouts, pass idempotency keys, schema-validate responses,
 * and surface failures as thrown errors. No card data ever flows through this server — only references.
 */
export interface PaymentSetup {
  /** A stable provider identifier for audit/reporting (e.g. `stripe`, `noop`). */
  readonly provider: string;
  /**
   * Create (idempotently) a PSP customer for a new signup.
   *
   * @param request - Email, idempotency key, optional metadata.
   * @returns The customer reference (no card data).
   */
  createCustomer(request: CreateCustomerRequest): Promise<CreateCustomerResult>;
  /**
   * Begin a payment-method setup for a customer; returns a client secret for the browser SDK.
   *
   * @param request - Customer ref, idempotency key, optional metadata.
   * @returns The setup-intent id + client secret.
   */
  createSetupIntent(request: CreateSetupIntentRequest): Promise<CreateSetupIntentResult>;
  /**
   * Read back a setup intent's state to verify (server-side) that a payment method was actually saved
   * before provisioning. Never trust the client's claim of success.
   *
   * @param setupIntentId - The id from {@link CreateSetupIntentResult}.
   * @returns The normalized setup-intent state.
   */
  getSetupIntent(setupIntentId: string): Promise<SetupIntentState>;

  /**
   * Set `paymentMethodRef` as the customer's **default** payment method for future off-session
   * charges. This is the step that makes a customer's "update card" actually take effect: the charge
   * path (`PaymentGateway.charge`) sends `customer` + `off_session` with **no** explicit method, so
   * Stripe uses the customer's `invoice_settings.default_payment_method` — which only this call
   * updates. Without it a saved card is verified but never used (the old default keeps being charged).
   *
   * Must be called **only after** the caller has verified server-side that the method belongs to this
   * customer (the SetupIntent succeeded and `customerRef` matches the tenant's billing customer); the
   * adapter does not re-authorize. Throws on a non-2xx upstream response (fail closed — the caller
   * must not report success if this throws). No card data is sent or returned — only references.
   *
   * @param customerRef - The PSP customer (from {@link CreateCustomerResult}); the tenant's own.
   * @param paymentMethodRef - The verified payment-method reference to make default.
   */
  setDefaultPaymentMethod(customerRef: string, paymentMethodRef: string): Promise<void>;
}
