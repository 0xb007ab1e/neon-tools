// Typed client for the /portal/api/* endpoints. Same-origin, cookie-carried session (the portal
// session cookie is HttpOnly + set by the server on login); we never store the session in the
// browser. Mutations carry the signed per-session CSRF token in the X-TF-CSRF header (fetched from
// GET /api/csrf), which the server re-derives from the live session and constant-time compares.
//
// The client is UNTRUSTED: every check here is for UX only — the server re-validates and authorizes
// each request server-side (tenant id is derived from the session, never sent by the client).

const BASE = '/portal/api';
/** The custom header carrying the signed per-session CSRF token on every mutation (server: F4). */
const CSRF_HEADER = 'X-TF-CSRF';

/** Advertised SPA capabilities — `destructiveActions` gates the Danger zone (flag OFF ⇒ hidden). */
export interface Features {
  /** Whether cancel + erasure self-serve endpoints exist (server feature flag — default OFF). */
  destructiveActions: boolean;
  /**
   * Whether the self-serve compliance-evidence surface exists (list/download/self-generate the
   * tenant's own signed bundles). A benign server rollout flag — default OFF, INDEPENDENT of
   * `destructiveActions` (evidence is non-destructive). Gates the Evidence section.
   */
  evidence: boolean;
}

/** Public SPA config (no secrets): the Stripe publishable key (when configured) + capabilities. */
export interface PortalConfig {
  /** Stripe publishable key for Stripe Elements; absent when no payment gateway is configured. */
  publishableKey?: string;
  /** Advertised capabilities. */
  features: Features;
  /** Login mode: `oidc` ⇒ the SPA uses the server-side code flow; `token` ⇒ the dev/token form. */
  auth: { mode: 'oidc' | 'token' };
}

/** The authenticated session view returned by login / GET /api/session. */
export interface SessionView {
  /** The session tenant id (server-derived; shown for support reference only). */
  tenantId: string;
  /** Advertised capabilities for this session. */
  features: Features;
}

/** The tenant's account summary (GET /api/me). */
export interface TenantSummary {
  id: string;
  slug: string;
  region: string;
  status: string;
  createdAt: string;
  planPriceUsd?: number;
}

/** Aggregated resource consumption for the current period (GET /api/usage). */
export interface Usage {
  tenantId: string;
  period: { from: string; to: string };
  consumption: {
    computeTimeSeconds: number;
    activeTimeSeconds: number;
    writtenDataBytes: number;
    syntheticStorageBytes: number;
  };
}

/** A tenant-scoped audit/billing event (charges / refunds / receipts). */
export interface TenantEvent {
  event: string;
  at: string;
  outcome: 'ok' | 'error';
  tenantId?: string;
  context?: Record<string, unknown>;
}

/** A generated invoice document (GET /api/invoices). */
export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unit: string;
  unitPriceUsd: number;
  amountUsd: number;
}
export interface Invoice {
  tenantId: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  generatedAt: string;
  lineItems: InvoiceLineItem[];
  totalUsd: number;
}

/** The plan catalog + the tenant's current price (GET /api/plan). */
export interface PlanView {
  current: number | null;
  available: { id: string; priceUsd: number }[];
}

/** A prorated quote for a plan change (POST /api/plan/preview). */
export interface PlanPreview {
  tenantId: string;
  oldPriceUsd: number;
  newPriceUsd: number;
  period: { from: string; to: string };
  proratedDeltaMinor: number;
}

/** The applied plan change report (POST /api/plan/change). */
export interface PlanChangeReport extends PlanPreview {
  settlement: 'none' | 'charged' | 'credited' | 'refunded' | 'skipped';
  settlementId?: string;
}

/** A PSP SetupIntent for the tenant's card (POST /api/payment-method/setup-intent). */
export interface PaymentSetup {
  clientSecret: string;
  setupIntentId: string;
  publishableKey?: string;
}

/** The safe result of setting a default payment method (no card data). */
export interface PaymentMethodResult {
  tenantId: string;
  hasDefault: true;
  setupIntentId: string;
}

/** The credit balance for the tenant (GET /api/credit-balance), in minor units. */
export interface CreditBalance {
  balanceMinor: number;
  currency: string;
}

/** The outcome of a self-serve cancel (POST /api/cancel). */
export interface CancelResult {
  tenantId: string;
  status: string;
  reversibleUntil: string;
}

/** A scheduled (cancellable) erasure record (GET/POST /api/erasure). */
export interface PendingErasure {
  requestedAt: string;
  executeAt: string;
  status: 'pending' | 'processing' | 'cancelled' | 'done';
}

/** The outcome of a data-export request (POST /api/data-export). */
export interface ExportResult {
  location: string;
  bytes: number | null;
}

/** Per-artifact SHA-256 (hex) content hashes recorded on an evidence manifest (spot-check aid). */
export interface EvidenceContentHashes {
  inventory: string;
  isolation: string;
  residency: string;
  auditExcerpt: string;
  erasureCertificates: string;
}

/**
 * The **facts-only** index record for one of the tenant's persisted evidence bundles
 * (GET /api/evidence) — never the JWS body, never secrets. The `bundleId` is a non-guessable handle
 * the download route dereferences (scoped server-side to this tenant — BOLA defense).
 */
export interface EvidenceManifestEntry {
  bundleId: string;
  scope: 'fleet' | 'tenant';
  tenantId?: string;
  generatedAt: string;
  storedAt: string;
  signerKid: string;
  contentHashes: EvidenceContentHashes;
  retentionUntil?: string;
}

/**
 * A signed evidence bundle (`{ bundle, jws }`, GET /api/evidence/:bundleId) — the tenant's own
 * verified attestation facts plus the compact JWS authenticity anchor an auditor verifies offline
 * with the public key. No secrets; a tenant bundle carries only this tenant's facts.
 */
export interface SignedEvidenceBundle {
  bundle: {
    scope: 'fleet' | 'tenant';
    tenantId?: string;
    generatedAt: string;
    artifacts: {
      inventory: { total: number; byStatus: Record<string, number> };
      isolation: { compliant: boolean };
      residency: { compliant: boolean };
      auditExcerpt: unknown[];
      erasureCertificates: string[];
    };
    contentHashes: EvidenceContentHashes;
  };
  jws: string;
}

/** A public JSON Web Key (Ed25519 / OKP) — public material ONLY; never carries a private `d`. */
export interface PublicJwk {
  kty: string;
  crv?: string;
  x?: string;
  kid?: string;
  alg?: string;
  use?: string;
}

/** A typed error carrying the HTTP status so views can branch (e.g. 404 ⇒ feature absent). */
export class ApiError extends Error {
  /** The HTTP status the server returned. */
  readonly status: number;
  /** @param message - Safe, user-facing message. @param status - The HTTP status. */
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

let csrfToken: string | null = null;

/** Fetch + cache the signed per-session CSRF token (minted from the live session — rotates with it). */
async function ensureCsrf(): Promise<string> {
  if (csrfToken !== null) return csrfToken;
  const res = await fetch(`${BASE}/csrf`, { credentials: 'include' });
  if (!res.ok) throw new ApiError('could not obtain a CSRF token', res.status);
  const body = (await res.json()) as { csrfToken?: unknown };
  if (typeof body.csrfToken !== 'string') throw new ApiError('malformed CSRF token', 500);
  csrfToken = body.csrfToken;
  return csrfToken;
}

/** Forget the cached CSRF token (on logout / 403 so it's re-fetched against the fresh session). */
export function resetCsrf(): void {
  csrfToken = null;
}

/** Parse the server's `{ error }` (already safe/user-facing) on a non-2xx, else return the body. */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: {
      ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  let body: unknown = undefined;
  try {
    body = await res.json();
  } catch {
    /* 204 / empty — leave undefined */
  }
  if (!res.ok) {
    // A failed mutation may be a stale CSRF token (session rotated/expired) — drop the cache so the
    // next mutation re-fetches a fresh one.
    if (res.status === 403) resetCsrf();
    const msg =
      body !== null && typeof body === 'object' && 'error' in body
        ? String(body.error)
        : `request failed (${res.status})`;
    throw new ApiError(msg, res.status);
  }
  return body as T;
}

/** Run a mutating request with the CSRF header (fetches/caches the token first). */
async function mutate<T>(path: string, body?: unknown, extraHeaders?: HeadersInit): Promise<T> {
  const token = await ensureCsrf();
  return call<T>(path, {
    method: 'POST',
    headers: { [CSRF_HEADER]: token, ...extraHeaders },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

export const api = {
  // --- session / config ---------------------------------------------------------------------------
  config: (): Promise<PortalConfig> => call('/config'),
  session: (): Promise<SessionView> => call('/session'),
  /**
   * Begin OIDC login: ask the server to start an Authorization Code + PKCE flow. The server pins
   * state/nonce/verifier in a cookie and returns the IdP authorize URL for the SPA to redirect to —
   * the SPA never generates or handles any of those secrets (H1/H2).
   */
  loginStart: (): Promise<{ authorizeUrl: string }> => call('/login/start'),
  /**
   * Complete OIDC login: hand the server the `code` + `state` from the IdP callback (query params).
   * The server verifies `state` against the pinned cookie, exchanges the code, and verifies the
   * id_token + nonce — the SPA never sees a token.
   */
  loginWithCode: (code: string, state: string): Promise<SessionView> =>
    call('/session', { method: 'POST', body: JSON.stringify({ code, state }) }),
  /** Static/dev token login (token mode / local dev without a real IdP). */
  login: (token: string): Promise<SessionView> =>
    call('/session', { method: 'POST', body: JSON.stringify({ token }) }),
  logout: async (): Promise<void> => {
    await call('/session', { method: 'DELETE' });
    resetCsrf();
  },

  // --- reads --------------------------------------------------------------------------------------
  me: (): Promise<TenantSummary> => call('/me'),
  usage: (): Promise<Usage> => call('/usage'),
  charges: (): Promise<TenantEvent[]> =>
    call<{ charges: TenantEvent[] }>('/charges').then((b) => b.charges),
  refunds: (): Promise<TenantEvent[]> =>
    call<{ refunds: TenantEvent[] }>('/refunds').then((b) => b.refunds),
  receipts: (): Promise<TenantEvent[]> =>
    call<{ receipts: TenantEvent[] }>('/receipts').then((b) => b.receipts),
  invoices: (): Promise<Invoice[]> =>
    call<{ invoices: Invoice[] }>('/invoices').then((b) => b.invoices),
  creditBalance: (): Promise<CreditBalance> => call('/credit-balance'),
  plan: (): Promise<PlanView> => call('/plan'),

  // --- plan (mutations) ---------------------------------------------------------------------------
  previewPlan: (newPriceUsd: number): Promise<PlanPreview> =>
    mutate('/plan/preview', { newPriceUsd }),
  /** Apply a plan change. `idempotencyKey` makes the metadata write + settlement + audit at-most-once. */
  changePlan: (newPriceUsd: number, idempotencyKey: string): Promise<PlanChangeReport> =>
    mutate('/plan/change', { newPriceUsd }, { 'Idempotency-Key': idempotencyKey }),

  // --- payment method (Stripe Elements) -----------------------------------------------------------
  setupIntent: (): Promise<PaymentSetup> => mutate('/payment-method/setup-intent'),
  setDefaultPaymentMethod: (
    setupIntentId: string,
    idempotencyKey: string,
  ): Promise<PaymentMethodResult> =>
    mutate('/payment-method/set-default', { setupIntentId }, { 'Idempotency-Key': idempotencyKey }),

  // --- danger zone (only mounted server-side when destructiveActions is ON) -----------------------
  /** Request a single-use step-up code (emailed) for a destructive action. */
  requestStepUp: (action: 'cancel' | 'erasure'): Promise<void> => mutate('/step-up', { action }),
  cancel: (code: string): Promise<CancelResult> => mutate('/cancel', { code }),
  dataExport: (): Promise<ExportResult> => mutate('/data-export'),
  requestErasure: (code: string): Promise<PendingErasure> =>
    mutate('/erasure', { code, confirm: 'ERASE' }),
  cancelErasure: (): Promise<{ cancelled: true }> => mutate('/erasure/cancel'),
  pendingErasure: (): Promise<PendingErasure | null> =>
    call<{ pending: PendingErasure | null }>('/erasure').then((b) => b.pending),

  // --- compliance evidence (only mounted server-side when `evidence` is ON) ------------------------
  /** List MY persisted evidence-bundle manifests (facts only — never the JWS body). */
  evidenceList: (): Promise<EvidenceManifestEntry[]> =>
    call<{ manifests: EvidenceManifestEntry[] }>('/evidence').then((b) => b.manifests),
  /** Download MY signed bundle by id (server-scoped to my session tenant — 404 if not mine). */
  evidenceGet: (bundleId: string): Promise<SignedEvidenceBundle> =>
    call(`/evidence/${encodeURIComponent(bundleId)}`),
  /** The Ed25519 PUBLIC verification key (public material only); null when no signer is configured. */
  evidencePublicKey: (): Promise<PublicJwk | null> =>
    call<{ publicKey: PublicJwk }>('/evidence/public-key').then((b) => b.publicKey),
  /** Self-generate MY current evidence bundle (non-destructive; CSRF-protected). Returns its manifest. */
  evidenceGenerate: (): Promise<{ manifest: EvidenceManifestEntry | null }> =>
    mutate('/evidence/generate'),
};
