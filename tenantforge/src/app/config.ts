import { z } from 'zod';
import { KNOWN_REGIONS } from '../core/regions.js';
import { ROLES, isRole, assertPlanCatalog } from '../core/index.js';
import type { CostRates, BillingRates, PlanDefinition } from '../core/index.js';
import type { HttpCredential } from './http-server.js';

/**
 * Per-unit rates (USD) — all optional non-negative numbers. Used for both the **cost** rates (Neon's
 * wholesale cost) and the **billing** rates (the price charged to tenants); the two shapes are
 * identical, only their meaning differs.
 */
const CostRatesSchema = z
  .object({
    computeSecondUsd: z.number().nonnegative().optional(),
    activeSecondUsd: z.number().nonnegative().optional(),
    storageByteUsd: z.number().nonnegative().optional(),
    writtenByteUsd: z.number().nonnegative().optional(),
  })
  .strict();

/**
 * Parse the `TENANTFORGE_HTTP_CREDENTIALS` env (`id:role:token` entries, comma-separated). The token
 * may contain colons — only the first two colons split the entry.
 *
 * @param raw - The raw env value (may be undefined/empty).
 * @returns The parsed credentials, or undefined when unset.
 * @throws Error on a malformed entry, unknown role, or duplicate id.
 */
function parseHttpCredentials(raw: string | undefined): HttpCredential[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const seen = new Set<string>();
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((entry) => {
      const first = entry.indexOf(':');
      const second = entry.indexOf(':', first + 1);
      if (first <= 0 || second <= first) {
        throw new Error(`TENANTFORGE_HTTP_CREDENTIALS: malformed entry (want id:role:token)`);
      }
      const id = entry.slice(0, first);
      const role = entry.slice(first + 1, second);
      const token = entry.slice(second + 1);
      if (!isRole(role)) {
        throw new Error(
          `TENANTFORGE_HTTP_CREDENTIALS: role for "${id}" must be ${ROLES.join(' | ')}`,
        );
      }
      if (token === '') throw new Error(`TENANTFORGE_HTTP_CREDENTIALS: empty token for "${id}"`);
      if (seen.has(id)) throw new Error(`TENANTFORGE_HTTP_CREDENTIALS: duplicate id "${id}"`);
      seen.add(id);
      return { id, role, token };
    });
}

/**
 * Parse the `TENANTFORGE_PORTAL_CREDENTIALS` env (`tenantId:token` entries, comma-separated). The
 * token may contain colons — only the first colon splits the entry.
 *
 * @param raw - The raw env value (may be undefined/empty).
 * @returns The parsed tenant credentials, or undefined when unset.
 * @throws Error on a malformed entry, empty token, or duplicate tenant id.
 */
function parseTenantCredentials(
  raw: string | undefined,
): { tenantId: string; token: string }[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const seen = new Set<string>();
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((entry) => {
      const colon = entry.indexOf(':');
      if (colon <= 0) {
        throw new Error('TENANTFORGE_PORTAL_CREDENTIALS: malformed entry (want tenantId:token)');
      }
      const tenantId = entry.slice(0, colon);
      const token = entry.slice(colon + 1);
      if (token === '') {
        throw new Error(`TENANTFORGE_PORTAL_CREDENTIALS: empty token for "${tenantId}"`);
      }
      if (seen.has(tenantId)) {
        throw new Error(`TENANTFORGE_PORTAL_CREDENTIALS: duplicate tenant "${tenantId}"`);
      }
      seen.add(tenantId);
      return { tenantId, token };
    });
}

/**
 * Environment schema. Validated at startup so the process fails fast on misconfiguration
 * (12-Factor config). Secrets are read from the environment, never committed (workflow-secrets).
 */
const EnvSchema = z
  .object({
    // Control-plane registry (metadata only — never tenant data).
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    // Neon API — provisions/deletes a project per tenant. The account is org-scoped.
    NEON_API_KEY: z.string().min(1, 'NEON_API_KEY is required'),
    NEON_ORG_ID: z.string().min(1, 'NEON_ORG_ID is required'),
    NEON_API_BASE_URL: z.string().url().optional(),
    // Where per-tenant connection secrets live. `neon-pg` (default) = AES-256-GCM-encrypted in the
    // control-plane DB; `vault` = HashiCorp Vault KV v2. Cloud secret managers can follow later.
    TENANTFORGE_SECRET_BACKEND: z.enum(['neon-pg', 'vault']).default('neon-pg'),
    // Encrypts per-tenant connection secrets at rest (AES-256-GCM) for the `neon-pg` backend. MUST be
    // separate from DATABASE_URL's credential (separation of duties) and high-entropy. Min 16 chars.
    // Required only when TENANTFORGE_SECRET_BACKEND=neon-pg (enforced below).
    TENANTFORGE_SECRET_KEY: z
      .string()
      .min(16, 'TENANTFORGE_SECRET_KEY must be at least 16 chars')
      .optional(),
    // HashiCorp Vault (required only when TENANTFORGE_SECRET_BACKEND=vault).
    VAULT_ADDR: z.string().url().optional(),
    VAULT_TOKEN: z.string().min(1).optional(),
    VAULT_KV_MOUNT: z.string().min(1).default('secret'),
    VAULT_PATH_PREFIX: z.string().min(1).default('tenantforge'),
    VAULT_NAMESPACE: z.string().optional(),
    // Default region for provisioning when a request omits one (validated against the allow-list).
    TENANTFORGE_DEFAULT_REGION: z
      .enum(KNOWN_REGIONS as [string, ...string[]])
      .default('aws-us-east-1'),
    // Optional comma-separated allow-list of regions tenants may be provisioned in (residency
    // enforcement). Empty/unset = all known regions allowed. Each entry must be a known region.
    TENANTFORGE_ALLOWED_REGIONS: z
      .string()
      .optional()
      .transform((s) =>
        (s ?? '')
          .split(',')
          .map((r) => r.trim())
          .filter((r) => r.length > 0),
      )
      .refine((regions) => regions.every((r) => KNOWN_REGIONS.includes(r)), {
        message: `TENANTFORGE_ALLOWED_REGIONS may only contain known regions: ${KNOWN_REGIONS.join(', ')}`,
      }),
    // Offboard export strategy: `neon-archive` (default — retain the project, scale-to-zero) or
    // `pg-dump` (dump the tenant DB to an object store; needs TENANTFORGE_EXPORT_DIR for now).
    TENANTFORGE_EXPORTER: z.enum(['neon-archive', 'pg-dump']).default('neon-archive'),
    // Absolute directory (e.g. a mounted volume) where `pg-dump` artifacts are written. Required
    // when TENANTFORGE_EXPORTER=pg-dump (until S3/GCS object-store backends land).
    TENANTFORGE_EXPORT_DIR: z.string().optional(),
    // Retention window (days) an archived (offboarding) tenant is kept before the purge sweep.
    TENANTFORGE_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(30),
    // Worker poll interval (ms) between lifecycle-queue drains.
    TENANTFORGE_QUEUE_POLL_MS: z.coerce.number().int().positive().default(5000),
    // Deployment context. `production` is fail-fast/secure-by-default: it requires a real erasure
    // signing key (no ephemeral fallback). Anything else (default `development`) is a non-prod
    // context where, if no signing key is set, an EPHEMERAL Ed25519 keypair is generated at startup
    // for dev/test/CI ergonomics (with a clear warning; not verifiable across restarts).
    TENANTFORGE_ENV: z
      .enum(['development', 'test', 'staging', 'production'])
      .default('development'),
    // **Ed25519 private signing key for erasure certificates** (EdDSA compact JWS). A secret — from
    // the secret manager / env, never committed or logged (`@rules/workflow-secrets.md`). Accepts a
    // PKCS#8 PEM (`-----BEGIN PRIVATE KEY-----…`) or a private JWK (JSON: kty=OKP, crv=Ed25519, d).
    // **Required in production** (enforced below); in non-prod an ephemeral key is generated if unset.
    TENANTFORGE_ERASURE_SIGNING_KEY: z.string().min(1).optional(),
    // **Ed25519 private signing key for compliance reports** (EdDSA compact JWS; the compliance
    // evidence layer, ADR-0011 Phase 1). A secret — from the secret manager / env, never committed or
    // logged. Same format as the erasure key (PKCS#8 PEM or private JWK) but a **distinct purpose/kid**
    // so the two artifact classes can't be confused. **Required in production** (enforced below) for
    // the signed report; in non-prod an ephemeral key is generated if unset. The unsigned
    // `complianceReport()` path needs no key — only `signedComplianceReport()` does.
    TENANTFORGE_COMPLIANCE_SIGNING_KEY: z.string().min(1).optional(),
    // HTTP entrypoint auth. TENANTFORGE_HTTP_TOKEN is the single-admin shorthand. For per-operator
    // identity + RBAC, set TENANTFORGE_HTTP_CREDENTIALS as comma-separated `id:role:token` entries
    // (role = admin | readonly; the token may itself contain colons — only the first two split).
    TENANTFORGE_HTTP_TOKEN: z.string().optional(),
    TENANTFORGE_HTTP_CREDENTIALS: z.string().optional(),
    // HTTP auth mode: `token` (default — static per-operator credentials / admin-token shorthand) or
    // `oidc` (verify a Bearer JWT against an external issuer's JWKS — phishing-resistant, no static
    // shared secrets). In `oidc` mode the issuer/audience/JWKS endpoint below are required.
    TENANTFORGE_AUTH_MODE: z.enum(['token', 'oidc']).default('token'),
    TENANTFORGE_OIDC_ISSUER: z.string().url().optional(),
    TENANTFORGE_OIDC_AUDIENCE: z.string().min(1).optional(),
    TENANTFORGE_OIDC_JWKS_URI: z.string().url().optional(),
    // Claims the principal id + role are read from (defaults: `sub` / `role`). The role value must
    // be `admin` | `readonly`; anything else is rejected (unauthenticated).
    TENANTFORGE_OIDC_SUBJECT_CLAIM: z.string().min(1).default('sub'),
    TENANTFORGE_OIDC_ROLE_CLAIM: z.string().min(1).default('role'),
    // Optional claim carrying an explicit permission array (overrides the role's default grant).
    TENANTFORGE_OIDC_PERMISSIONS_CLAIM: z.string().min(1).optional(),
    // Per-principal HTTP rate limit (fixed window).
    TENANTFORGE_RATE_LIMIT: z.coerce.number().int().positive().default(120),
    TENANTFORGE_RATE_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    // Rate-limit counter store: `memory` (default, per-instance) or `pg` (shared across instances
    // via the control-plane DB — use for multi-instance deployments).
    TENANTFORGE_RATE_LIMIT_STORE: z.enum(['memory', 'pg']).default('memory'),
    // Idempotency-key store: `memory` (default, per-instance) or `pg` (shared across instances —
    // use for multi-instance deployments so a retry on another replica still de-duplicates).
    TENANTFORGE_IDEMPOTENCY_STORE: z.enum(['memory', 'pg']).default('memory'),
    // Persisted audit trail: `none` (default — stdout JSON stream only) or `pg` (durable,
    // queryable `tf_audit_log`). `pg` enables erasure-history + recent-excerpt in the compliance
    // report and survives restarts/multi-instance. Requires migration 0006.
    TENANTFORGE_AUDIT_LOG: z.enum(['none', 'pg']).default('none'),
    // Credit ledger (downgrade credits + applying credit to charges): `none` (off — downgrades fall
    // back to a capped refund), `memory` (process-local; dev/single-instance), or `pg` (durable,
    // authoritative, cross-instance — `tf_credits`, migration 0007). Recommended `pg` in production.
    TENANTFORGE_CREDIT_LEDGER: z.enum(['none', 'memory', 'pg']).default('none'),
    // Signup/invite token store (self-serve onboarding): `none` (off), `memory` (process-local;
    // dev/single-instance), or `pg` (durable — tf_signup_tokens, migration 0008). Enables
    // issue/redeem/list signup tokens. Only the token hash is stored.
    TENANTFORGE_SIGNUP_TOKEN_STORE: z.enum(['none', 'memory', 'pg']).default('none'),
    // Pending-erasure (undo-window) store: `memory` (default, per-instance) or `pg` (durable +
    // cross-replica — `tf_pending_erasures`, migration 0012). `pg` makes the cancel/claim flips
    // atomic across replicas and survive restarts — the prerequisite for flipping
    // TENANTFORGE_PORTAL_SELFSERVE_DESTRUCTIVE on in multi-replica / restart-sensitive production
    // (threat-model B8w / red-team F2, ADR-0010).
    TENANTFORGE_PENDING_ERASURE_STORE: z.enum(['memory', 'pg']).default('memory'),
    // Evidence-at-rest store for signed compliance bundles (ADR-0011 Phase 3a/3b): `memory` (default,
    // per-instance dev/test); `object-store` (persist the signed bundle body durably to the export
    // object store — requires TENANTFORGE_EXPORT_DIR; encrypt-at-rest is the object store's concern,
    // but the manifest INDEX is in-process so get/list do NOT survive restart — Phase 3a limitation);
    // or `pg` (Phase 3b — the **durable** index: manifest + no-secret signed body in Postgres
    // `tf_evidence_bundles` (migration 0013), so get/list/prune survive restart and hold across
    // replicas — the production backend for the Phase 3b retrieval surface). Non-guessable,
    // tenant-scoped keys. Mirrors TENANTFORGE_PENDING_ERASURE_STORE.
    TENANTFORGE_EVIDENCE_STORE: z.enum(['memory', 'object-store', 'pg']).default('memory'),
    // Default retention window (days) recorded on a persisted evidence bundle's manifest; `0`
    // (default) ⇒ indefinite retention (auditors keep evidence durably — data-lifecycle). Drives
    // `retentionUntil` + the `evidencePrune` sweep.
    TENANTFORGE_EVIDENCE_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(0),
    // Transport-security escape hatches (default false — fail closed). `..._DB` permits a non-TLS
    // Postgres connection (no `sslmode=require`); `..._URLS` permits a non-https outbound URL
    // (Neon API / Vault / Azure Key Vault / OIDC JWKS / Stripe). Set ONLY for local development
    // against a loopback service with no certificate — these are the documented "leaky endpoints"
    // (README §TLS); never enable in production (master §5: no plaintext, fail closed).
    TENANTFORGE_ALLOW_INSECURE_DB: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    TENANTFORGE_ALLOW_INSECURE_URLS: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // Cache getConnection resolutions for this many ms (0 = disabled). Process-local + tenant-keyed.
    TENANTFORGE_CONNECTION_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(0),
    // Web dashboard: when set, mount the cookie-session dashboard backend at /dashboard. The value
    // is the HMAC key that signs session cookies (a secret). Unset = dashboard disabled.
    TENANTFORGE_DASHBOARD_SECRET: z.string().min(1).optional(),
    // Path to the built SPA (`dashboard/dist`); when set, the dashboard also serves the front-end,
    // so a production deploy needs no separate static web server. Unset = JSON API only.
    TENANTFORGE_DASHBOARD_DIST: z.string().min(1).optional(),
    // Path to the built signup SPA (`signup/dist`); when set (with signup enabled), the /signup
    // sub-app also serves the front-end.
    TENANTFORGE_SIGNUP_DIST: z.string().min(1).optional(),
    // Path to the built portal SPA (`portal/dist`); when set (with the portal mounted), the /portal
    // sub-app also serves the customer-facing front-end (scoped CSP allows Stripe.js).
    TENANTFORGE_PORTAL_DIST: z.string().min(1).optional(),
    // Customer-facing self-serve portal: when set (with PORTAL_CREDENTIALS), mount the tenant portal
    // at /portal. The value is the HMAC key that signs portal session cookies (a secret).
    TENANTFORGE_PORTAL_SECRET: z.string().min(1).optional(),
    // Portal credentials: comma-separated `tenantId:token` pairs (the token is a secret). Each token
    // authenticates as exactly its tenant; the portal shows only that tenant's data.
    TENANTFORGE_PORTAL_CREDENTIALS: z.string().min(1).optional(),
    // Portal auth mode: `token` (default — the static PORTAL_CREDENTIALS map) or `oidc` (verify a
    // customer-IdP JWT whose claim carries the tenant id). For `oidc`, the PORTAL_OIDC_* below are required.
    TENANTFORGE_PORTAL_AUTH_MODE: z.enum(['token', 'oidc']).default('token'),
    TENANTFORGE_PORTAL_OIDC_ISSUER: z.string().url().optional(),
    TENANTFORGE_PORTAL_OIDC_AUDIENCE: z.string().min(1).optional(),
    TENANTFORGE_PORTAL_OIDC_JWKS_URI: z.string().url().optional(),
    // The JWT claim carrying the tenant id. Defaults to `tenant`.
    TENANTFORGE_PORTAL_OIDC_TENANT_CLAIM: z.string().min(1).default('tenant'),
    // Server-side Authorization Code + PKCE for the portal SPA (H1/H2). When the authorize + token
    // endpoints + redirect URI are set, the SPA logs in via the code flow (server-pinned state/nonce/
    // verifier; the SPA never handles a raw token). Required together for `oidc` mode.
    TENANTFORGE_PORTAL_OIDC_AUTHORIZE_URL: z.string().url().optional(),
    TENANTFORGE_PORTAL_OIDC_TOKEN_URL: z.string().url().optional(),
    // The redirect URI registered with the IdP (the portal callback, e.g. https://host/portal/).
    TENANTFORGE_PORTAL_OIDC_REDIRECT_URI: z.string().url().optional(),
    // OAuth client id; defaults to the audience when unset.
    TENANTFORGE_PORTAL_OIDC_CLIENT_ID: z.string().min(1).optional(),
    // OAuth scope; defaults to `openid`.
    TENANTFORGE_PORTAL_OIDC_SCOPE: z.string().min(1).default('openid'),
    // Optional OAuth client secret (confidential client) — a secret from env/secret manager; never
    // committed or logged. Omit for a public client (PKCE alone authenticates the exchange).
    TENANTFORGE_PORTAL_OIDC_CLIENT_SECRET: z.string().min(1).optional(),
    // Self-serve portal write surface (ADR-0010 / threat-model B8w). The destructive pair
    // (cancel + erasure) ships behind a feature flag that is OFF by default (red-team F6); the
    // payment/plan/invoice reads + writes are always available when the portal is mounted.
    TENANTFORGE_PORTAL_SELFSERVE_DESTRUCTIVE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // Self-serve compliance-evidence surface (ADR-0011 Phase 3d / threat-model B8e): a tenant
    // lists/downloads its OWN signed evidence bundles + the public key, and may self-generate its own
    // current bundle. A benign, default-OFF rollout flag for staged rollout of a new customer-facing
    // surface — INDEPENDENT of TENANTFORGE_PORTAL_SELFSERVE_DESTRUCTIVE (this read/self-generate path
    // is non-destructive and must not entangle with the cancel/erasure gate).
    TENANTFORGE_PORTAL_SELFSERVE_EVIDENCE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // TTL (ms) for a portal step-up second-factor code (cancel/erasure). Default 10 minutes.
    TENANTFORGE_PORTAL_STEPUP_TTL_MS: z.coerce.number().int().positive().default(600_000),
    // Mandatory erasure undo window (ms) — how long a tenant may cancel a scheduled erasure.
    // Default 48h; window + execution must stay within the statutory erasure SLA (B8w).
    TENANTFORGE_PORTAL_ERASURE_UNDO_WINDOW_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(48 * 60 * 60 * 1000),
    // Directory of ordered migration `.sql` files (the catalog). When set, the dashboard can EXECUTE
    // a fleet reconcile (tenant:provision-gated) — the server loads the SQL from here. Unset =
    // reconcile is preview-only in the browser (execution stays a CLI op).
    TENANTFORGE_MIGRATIONS_DIR: z.string().min(1).optional(),
    // Unit cost rates for the cost/margin report, as a JSON object of USD-per-unit numbers, e.g.
    // {"computeSecondUsd":0.00016,"storageByteUsd":1.5e-10}. Unset = zero cost (margin = price).
    TENANTFORGE_COST_RATES: z.string().optional(),
    // Per-unit BILLING (sell) rates for invoice generation, same JSON shape as the cost rates — the
    // prices charged to tenants (distinct from cost). Unset = usage not billed (invoice = plan fee
    // from metadata.priceUsd only). Generates invoice documents; it does not charge a card.
    TENANTFORGE_BILLING_RATES: z.string().optional(),
    // The operator's plan catalog as a JSON array of plans: `[{ "id": "pro", "name": "Pro",
    // "priceUsd": 49, "includedUsage": { "computeTimeSeconds": 10000 } }]`. Empty/unset = no catalog
    // (assignPlan fails closed). YOUR product tiers — Neon has no concept of them; validated at load.
    TENANTFORGE_PLANS: z.string().optional(),
    // Usage-alert thresholds as a comma-separated list of fractions of a tenant's included
    // allowance (e.g. `0.8,1.0` = warn at 80% and at 100%). Empty/unset = usage alerts off. Each
    // entry must be a positive number. Alerts apply the operator's plan-allowance policy on top of
    // Neon's metering (Neon doesn't know per-tenant plan allowances) — not a Neon feature.
    TENANTFORGE_USAGE_ALERT_THRESHOLDS: z
      .string()
      .optional()
      .transform((s) =>
        (s ?? '')
          .split(',')
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
          .map((t) => Number(t)),
      )
      .refine((ts) => ts.every((t) => Number.isFinite(t) && t > 0), {
        message: 'TENANTFORGE_USAGE_ALERT_THRESHOLDS must be positive numbers (e.g. 0.8,1.0)',
      }),
    // Payment gateway (PSP) for charging invoices: `none` (default — charging fails closed) or
    // `stripe`. `stripe` requires STRIPE_SECRET_KEY (enforced below). Charging is a money-moving
    // outward action — opt-in only, never auto-enabled.
    TENANTFORGE_PAYMENT_GATEWAY: z.enum(['none', 'stripe']).default('none'),
    // Stripe secret API key (sk_…) — required when TENANTFORGE_PAYMENT_GATEWAY=stripe. A secret;
    // from the secret manager / env, never committed or logged.
    STRIPE_SECRET_KEY: z.string().min(1).optional(),
    // Override the Stripe API base URL (optional; defaults to the public API — set for a mock/proxy).
    STRIPE_API_BASE_URL: z.string().url().optional(),
    // Stripe **webhook signing secret** (whsec_…) — distinct from the API key. When set (with
    // paymentGateway=stripe), the inbound webhook endpoint (POST /webhooks/payment) is mounted and
    // verifies signatures with it. A secret; never committed/logged.
    TENANTFORGE_PAYMENT_WEBHOOK_SECRET: z.string().min(1).optional(),
    // Billing receipts (optional): `none` (default — no receipts), `log` (record an auditable
    // receipt trail, no external send), or `http` (POST each receipt to a relay — requires
    // NOTIFIER_URL). A successful charge/refund best-effort emails the tenant's metadata.billingEmail.
    TENANTFORGE_NOTIFIER: z.enum(['none', 'log', 'http']).default('none'),
    // Relay endpoint for TENANTFORGE_NOTIFIER=http (must be https); optional HMAC signing secret.
    TENANTFORGE_NOTIFIER_URL: z.string().url().optional(),
    TENANTFORGE_NOTIFIER_SECRET: z.string().min(1).optional(),
    // Ops recipient for the operator alert digest (operatorDigest({ notify: true })); needs a notifier.
    TENANTFORGE_OPERATOR_EMAIL: z.string().min(1).optional(),
    // --- Self-serve signup (public, payment-gated web onboarding) ---
    // HMAC key for the signup-session cookie; **set ⇒ self-serve signup is enabled** and (enforced
    // below) requires Stripe, a captcha provider, and a notifier. A secret; never committed/logged.
    TENANTFORGE_SIGNUP_SECRET: z.string().min(1).optional(),
    // Backend for the signup stores (email-verification + funnel): `pg` (durable) or `memory` (dev).
    TENANTFORGE_SIGNUP_STORE: z.enum(['memory', 'pg']).default('pg'),
    // TTL (ms) for an emailed verification code. Default 15 minutes.
    TENANTFORGE_EMAIL_CODE_TTL_MS: z.coerce.number().int().positive().default(900_000),
    // Stripe **publishable** key (pk_…) — public, ships to the browser for Stripe.js. Required when
    // signup is enabled. Not a secret, but kept in config for symmetry.
    STRIPE_PUBLISHABLE_KEY: z.string().min(1).optional(),
    // Captcha provider gating the public signup: `none` (off) or `turnstile` (Cloudflare). When signup
    // is enabled it must be a real provider (enforced below).
    TENANTFORGE_CAPTCHA_PROVIDER: z.enum(['none', 'turnstile']).default('none'),
    // Captcha **secret** key (server-side siteverify) — required when the provider is set. A secret.
    TENANTFORGE_CAPTCHA_SECRET: z.string().min(1).optional(),
    // Captcha **site** key — public, ships to the browser widget. Required with a provider.
    TENANTFORGE_CAPTCHA_SITE_KEY: z.string().min(1).optional(),
    // Outbound lifecycle webhook (optional): HMAC-signed POST of each event to an external endpoint.
    TENANTFORGE_WEBHOOK_URL: z.string().url().optional(),
    TENANTFORGE_WEBHOOK_SECRET: z.string().min(1).optional(),
    // Optional comma-separated allow-list of event names to send (empty = all events).
    TENANTFORGE_WEBHOOK_EVENTS: z
      .string()
      .optional()
      .transform((v) =>
        v === undefined
          ? undefined
          : v
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0),
      ),
    TENANTFORGE_PORT: z.coerce.number().int().positive().default(3000),
  })
  .superRefine((env, ctx) => {
    // A webhook needs both a URL and a signing secret, or neither (fail fast on a half-config).
    if (
      (env.TENANTFORGE_WEBHOOK_URL === undefined) !==
      (env.TENANTFORGE_WEBHOOK_SECRET === undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TENANTFORGE_WEBHOOK_SECRET'],
        message: 'TENANTFORGE_WEBHOOK_URL and TENANTFORGE_WEBHOOK_SECRET must be set together',
      });
    }
    // The secret backend selects which credentials are mandatory (fail fast on misconfig).
    if (env.TENANTFORGE_SECRET_BACKEND === 'neon-pg' && env.TENANTFORGE_SECRET_KEY === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TENANTFORGE_SECRET_KEY'],
        message: 'TENANTFORGE_SECRET_KEY is required when TENANTFORGE_SECRET_BACKEND=neon-pg',
      });
    }
    if (env.TENANTFORGE_SECRET_BACKEND === 'vault') {
      if (env.VAULT_ADDR === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['VAULT_ADDR'],
          message: 'VAULT_ADDR is required when TENANTFORGE_SECRET_BACKEND=vault',
        });
      }
      if (env.VAULT_TOKEN === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['VAULT_TOKEN'],
          message: 'VAULT_TOKEN is required when TENANTFORGE_SECRET_BACKEND=vault',
        });
      }
    }
    // Production must ship a real erasure signing key — an ephemeral key would not be verifiable
    // across restarts (no published, stable public key), defeating the certificate's purpose. Fail
    // fast at startup (12-Factor; secure-by-default) rather than silently degrade.
    if (env.TENANTFORGE_ENV === 'production' && env.TENANTFORGE_ERASURE_SIGNING_KEY === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TENANTFORGE_ERASURE_SIGNING_KEY'],
        message:
          'TENANTFORGE_ERASURE_SIGNING_KEY is required when TENANTFORGE_ENV=production (erasure ' +
          'certificates are always signed; an ephemeral key is non-prod only)',
      });
    }
    // Production must ship a real compliance signing key too — the signed compliance report
    // (ADR-0011) is only auditor-verifiable against a stable published key. Same fail-fast rationale.
    if (
      env.TENANTFORGE_ENV === 'production' &&
      env.TENANTFORGE_COMPLIANCE_SIGNING_KEY === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TENANTFORGE_COMPLIANCE_SIGNING_KEY'],
        message:
          'TENANTFORGE_COMPLIANCE_SIGNING_KEY is required when TENANTFORGE_ENV=production (the signed ' +
          'compliance report needs a stable, published key; an ephemeral key is non-prod only)',
      });
    }
    // OIDC mode needs the issuer, audience, and JWKS endpoint to verify tokens (fail fast).
    if (env.TENANTFORGE_AUTH_MODE === 'oidc') {
      if (env.TENANTFORGE_OIDC_ISSUER === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TENANTFORGE_OIDC_ISSUER'],
          message: 'TENANTFORGE_OIDC_ISSUER is required when TENANTFORGE_AUTH_MODE=oidc',
        });
      }
      if (env.TENANTFORGE_OIDC_AUDIENCE === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TENANTFORGE_OIDC_AUDIENCE'],
          message: 'TENANTFORGE_OIDC_AUDIENCE is required when TENANTFORGE_AUTH_MODE=oidc',
        });
      }
      if (env.TENANTFORGE_OIDC_JWKS_URI === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TENANTFORGE_OIDC_JWKS_URI'],
          message: 'TENANTFORGE_OIDC_JWKS_URI is required when TENANTFORGE_AUTH_MODE=oidc',
        });
      }
    }
    // Portal OIDC mode needs its issuer/audience/JWKS plus the code-flow endpoints + redirect URI
    // (the SPA logs in via server-side Authorization Code + PKCE — H1/H2; static creds aren't used).
    if (env.TENANTFORGE_PORTAL_AUTH_MODE === 'oidc') {
      for (const key of [
        'TENANTFORGE_PORTAL_OIDC_ISSUER',
        'TENANTFORGE_PORTAL_OIDC_AUDIENCE',
        'TENANTFORGE_PORTAL_OIDC_JWKS_URI',
        'TENANTFORGE_PORTAL_OIDC_AUTHORIZE_URL',
        'TENANTFORGE_PORTAL_OIDC_TOKEN_URL',
        'TENANTFORGE_PORTAL_OIDC_REDIRECT_URI',
      ] as const) {
        if (env[key] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when TENANTFORGE_PORTAL_AUTH_MODE=oidc`,
          });
        }
      }
    }
    // The HTTP notifier needs a relay URL.
    if (env.TENANTFORGE_NOTIFIER === 'http' && env.TENANTFORGE_NOTIFIER_URL === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TENANTFORGE_NOTIFIER_URL'],
        message: 'TENANTFORGE_NOTIFIER_URL is required when TENANTFORGE_NOTIFIER=http',
      });
    }
    // The pg-dump exporter needs a destination directory until S3/GCS object stores land.
    if (env.TENANTFORGE_EXPORTER === 'pg-dump' && env.TENANTFORGE_EXPORT_DIR === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TENANTFORGE_EXPORT_DIR'],
        message: 'TENANTFORGE_EXPORT_DIR is required when TENANTFORGE_EXPORTER=pg-dump',
      });
    }
    // Fail fast rather than silently fall back to the in-memory store: an operator who selected the
    // object-store evidence backend for durability must not get non-durable persistence with no
    // signal (master §2 fail-closed; topic-config-environments "validate at startup, fail fast").
    if (
      env.TENANTFORGE_EVIDENCE_STORE === 'object-store' &&
      env.TENANTFORGE_EXPORT_DIR === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TENANTFORGE_EXPORT_DIR'],
        message: 'TENANTFORGE_EXPORT_DIR is required when TENANTFORGE_EVIDENCE_STORE=object-store',
      });
    }
    // Production requires a DURABLE evidence store. Neither non-`pg` backend is prod-safe for
    // auditable retrieval: `memory` loses every persisted bundle + its manifest on restart, and
    // `object-store` (Phase 3a) keeps the manifest INDEX in-process — so after a restart get/list
    // silently return nothing even though the bodies are on disk (`src/ports/evidence-store.ts`).
    // Only `pg` (`tf_evidence_bundles`, migration 0013) survives restart + holds across replicas.
    // Fail fast at startup rather than ship an audit surface that silently loses evidence
    // (master §2 fail-closed; the evidence layer is the compliance product — losing it is SEV-grade).
    if (env.TENANTFORGE_ENV === 'production' && env.TENANTFORGE_EVIDENCE_STORE !== 'pg') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TENANTFORGE_EVIDENCE_STORE'],
        message:
          'TENANTFORGE_EVIDENCE_STORE must be "pg" when TENANTFORGE_ENV=production (memory loses ' +
          'persisted evidence on restart; object-store keeps the manifest index in-process so ' +
          'get/list break after restart — neither is durable for auditable retrieval)',
      });
    }
    // Destructive self-serve (cancel + erasure) requires a DURABLE pending-erasure store. With the
    // in-memory store the undo/claim CAS (`UPDATE … status='processing' WHERE id=? AND status=
    // 'pending'`) is per-instance and lost on restart — reopening the B8w / red-team-F2 race the
    // project gated against (a cancel and the executor on different replicas could both "win", or a
    // restart could drop a pending erasure mid-window). Only `pg` (`tf_pending_erasures`, migration
    // 0012) makes the flip atomic across replicas and durable. Fail closed: if the destructive flag
    // is on, the durable store is mandatory (master §2; ADR-0010).
    if (
      env.TENANTFORGE_PORTAL_SELFSERVE_DESTRUCTIVE === true &&
      env.TENANTFORGE_PENDING_ERASURE_STORE !== 'pg'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TENANTFORGE_PENDING_ERASURE_STORE'],
        message:
          'TENANTFORGE_PENDING_ERASURE_STORE must be "pg" when ' +
          'TENANTFORGE_PORTAL_SELFSERVE_DESTRUCTIVE=true (an in-memory pending-erasure store makes ' +
          'the cancel/claim CAS per-instance and lost on restart — the B8w/red-team-F2 race)',
      });
    }
  });

/** Resolved, validated configuration. */
export interface Config {
  /** Control-plane registry Postgres connection string. */
  databaseUrl: string;
  /** Neon API key (secret). */
  neonApiKey: string;
  /** Neon organization id (the account is org-scoped). */
  neonOrgId: string;
  /** Neon API base URL (defaults to the public API). */
  neonApiBaseUrl?: string;
  /** Default Neon region for provisioning. */
  defaultRegion: string;
  /** Allow-listed regions tenants may be provisioned in (empty = all known regions). */
  allowedRegions: string[];
  /** Permit non-TLS Postgres connections (no `sslmode=require`). Local dev only — leaky; default false. */
  allowInsecureDb: boolean;
  /** Permit non-https outbound URLs (Neon API / Vault / KV / OIDC / Stripe). Local dev only; default false. */
  allowInsecureUrls: boolean;
  /** Deployment context; `production` forbids the ephemeral erasure-signing-key fallback (fail-fast). */
  env: 'development' | 'test' | 'staging' | 'production';
  /**
   * Ed25519 **private** signing key for erasure certificates (PKCS#8 PEM or private JWK; a secret).
   * Required in production. Absent in non-prod ⇒ an ephemeral keypair is generated at startup.
   */
  erasureSigningKey?: string;
  /**
   * Ed25519 **private** signing key for compliance reports (PKCS#8 PEM or private JWK; a secret;
   * ADR-0011). Required in production for the signed report. Absent in non-prod ⇒ an ephemeral
   * keypair is generated at startup. Distinct purpose/kid from {@link erasureSigningKey}.
   */
  complianceSigningKey?: string;
  /** Which backend stores per-tenant connection secrets. */
  secretBackend: 'neon-pg' | 'vault';
  /** AES passphrase for the `neon-pg` secret backend (separate from the DB cred); set when that backend is used. */
  secretKey?: string;
  /** HashiCorp Vault settings, set when `secretBackend` is `vault`. */
  vault?: {
    /** Vault server base URL (use TLS). */
    address: string;
    /** Vault token (secret). */
    token: string;
    /** KV v2 mount path. */
    mount: string;
    /** Path prefix under the mount. */
    pathPrefix: string;
    /** Vault Enterprise namespace, if any. */
    namespace?: string;
  };
  /** Offboard export strategy. */
  exporter: 'neon-archive' | 'pg-dump';
  /** Filesystem directory for `pg-dump` artifacts (set when `exporter` is `pg-dump`). */
  exportDir?: string;
  /** Retention window (days) before an archived tenant is purged. */
  retentionDays: number;
  /** Worker poll interval (ms) between lifecycle-queue drains. */
  queuePollMs: number;
  /** HTTP auth mode: static `token` credentials or external `oidc` (JWT) verification. */
  authMode: 'token' | 'oidc';
  /** OIDC verification settings, set when `authMode` is `oidc`. */
  oidc?: {
    /** Expected token issuer (`iss`). */
    issuer: string;
    /** Expected audience (`aud`). */
    audience: string;
    /** The issuer's JWKS endpoint. */
    jwksUri: string;
    /** Claim carrying the principal id (default `sub`). */
    subjectClaim: string;
    /** Claim carrying the role (default `role`). */
    roleClaim: string;
    /** Optional claim carrying an explicit permission array. */
    permissionsClaim?: string;
  };
  /** Admin-token shorthand for the HTTP entrypoint (required only when serving HTTP). */
  httpToken?: string;
  /** Per-operator HTTP credentials (preferred over httpToken); set when configured. */
  httpCredentials?: HttpCredential[];
  /** Per-principal HTTP rate limit (fixed window). */
  rateLimit: { limit: number; windowMs: number };
  /** Rate-limit counter store: in-memory (per-instance) or Postgres (shared across instances). */
  rateLimitStore: 'memory' | 'pg';
  /** Idempotency-key store: in-memory (per-instance) or Postgres (shared across instances). */
  idempotencyStore: 'memory' | 'pg';
  /**
   * Pending-erasure (undo-window) store: in-memory (per-instance) or Postgres (durable +
   * cross-replica). `pg` is the prerequisite for the portal's destructive self-serve flag in
   * multi-replica / restart-sensitive production (threat-model B8w / red-team F2, ADR-0010).
   */
  pendingErasureStore: 'memory' | 'pg';
  /**
   * Evidence-at-rest store (ADR-0011 Phase 3a/3b): `memory` (per-instance dev/test); `object-store`
   * (signed body to the export object store; requires {@link exportDir}; index in-process — get/list
   * do not survive restart, the 3a limitation); or `pg` (the **durable** index — manifest + no-secret
   * signed body in Postgres `tf_evidence_bundles`, so get/list/prune survive restart and hold across
   * replicas — the production backend for the Phase 3b retrieval surface). Non-guessable, tenant-
   * scoped keys.
   */
  evidenceStore: 'memory' | 'object-store' | 'pg';
  /** Default retention window (days) for a persisted evidence bundle; `0` ⇒ indefinite retention. */
  evidenceRetentionDays: number;
  /** Persisted audit trail: none (stdout only) or Postgres (durable, queryable). */
  auditLog: 'none' | 'pg';
  /** Credit ledger backend: none (off), memory (per-instance), or pg (durable, authoritative). */
  creditLedger: 'none' | 'memory' | 'pg';
  /** Cache `getConnection` resolutions for this many ms (0 = disabled). */
  connectionCacheTtlMs: number;
  /** Dashboard session-cookie HMAC key; set ⇒ the /dashboard backend is mounted. */
  dashboardSecret?: string;
  /** Path to the built SPA (`dashboard/dist`); set ⇒ the dashboard also serves the front-end. */
  dashboardDist?: string;
  /** Path to the built signup SPA (`signup/dist`); when set, the signup sub-app serves the front-end. */
  signupDist?: string;
  /** Path to the built portal SPA (`portal/dist`); when set, the portal sub-app serves the front-end. */
  portalDist?: string;
  /** Directory of ordered migration `.sql` files; set ⇒ the dashboard can execute a reconcile. */
  migrationsDir?: string;
  /** Portal session-cookie HMAC key; set (with `portalCredentials`) ⇒ the /portal is mounted. */
  portalSecret?: string;
  /** Static portal credentials (`tenantId` → token); set ⇒ the token tenant-authenticator is wired. */
  portalCredentials?: { tenantId: string; token: string }[];
  /** Portal auth mode: static `token` map or `oidc` (verify a customer-IdP JWT's tenant claim). */
  portalAuthMode: 'token' | 'oidc';
  /** Enable the portal's destructive self-serve actions (cancel + erasure). Default false (ADR-0010 / red-team F6). */
  portalSelfServeDestructive: boolean;
  /**
   * Enable the portal's self-serve compliance-evidence surface (list/download/self-generate the
   * tenant's own signed evidence bundles). Default false — a benign staged-rollout flag, independent
   * of {@link Config.portalSelfServeDestructive} (ADR-0011 Phase 3d / threat-model B8e).
   */
  portalSelfServeEvidence: boolean;
  /** TTL (ms) for a portal step-up second-factor code. */
  stepUpCodeTtlMs: number;
  /** Mandatory erasure undo window (ms) — how long a tenant may cancel a scheduled erasure. */
  erasureUndoWindowMs: number;
  /** Portal OIDC settings, set when `portalAuthMode` is `oidc`. */
  portalOidc?: {
    /** Expected token issuer (`iss`). */
    issuer: string;
    /** Expected audience (`aud`). */
    audience: string;
    /** The issuer's JWKS endpoint. */
    jwksUri: string;
    /** The claim carrying the tenant id. */
    tenantClaim: string;
    /** The IdP `authorization_endpoint` (server-side Authorization Code + PKCE — H1/H2). */
    authorizeUrl: string;
    /** The IdP `token_endpoint` (server-to-server code exchange). */
    tokenUrl: string;
    /** The redirect URI registered with the IdP (the portal callback). */
    redirectUri: string;
    /** OAuth client id (defaults to the audience). */
    clientId: string;
    /** OAuth scope (defaults to `openid`). */
    scope: string;
    /** Optional OAuth client secret (confidential client); a secret — never logged. */
    clientSecret?: string;
  };
  /** Unit cost rates (USD) for the cost/margin report; absent ⇒ zero cost. */
  costRates?: CostRates;
  /** Per-unit billing (sell) rates (USD) for invoice generation; absent ⇒ usage not billed. */
  billingRates?: BillingRates;
  /** Usage-alert thresholds (fractions of a tenant's included allowance); empty ⇒ alerts off. */
  usageAlertThresholds: number[];
  /** The operator's plan catalog (named tiers); absent ⇒ no catalog (assignPlan fails closed). */
  plans?: PlanDefinition[];
  /** Signup/invite token store backend: none (off), memory, or pg (durable). */
  signupTokenStore: 'none' | 'memory' | 'pg';
  /** Payment gateway for charging invoices: none (charging disabled) or stripe. */
  paymentGateway: 'none' | 'stripe';
  /** Stripe secret key; present ⇒ the Stripe gateway is wired (required when paymentGateway=stripe). */
  stripeSecretKey?: string;
  /** Override the Stripe API base URL (optional). */
  stripeApiBaseUrl?: string;
  /** Stripe webhook signing secret; set ⇒ the inbound webhook endpoint is mounted + verified. */
  paymentWebhookSecret?: string;
  /** Outbound lifecycle webhook (set only when both URL + secret are configured). */
  webhook?: { url: string; secret: string; eventTypes?: string[] };
  /** Billing-receipt notifier: none (off), log (audit-only), or http (POST to a relay). */
  notifier: 'none' | 'log' | 'http';
  /** HTTP notifier relay URL + optional signing secret (when notifier=http). */
  notifierHttp?: { url: string; secret?: string };
  /** Ops recipient for the operator alert digest (when set with a notifier). */
  operatorEmail?: string;
  /** HMAC key for the signup-session cookie; set ⇒ self-serve signup is enabled. */
  signupSecret?: string;
  /** Backend for the signup stores (email-verification + funnel). */
  signupStore: 'memory' | 'pg';
  /** TTL (ms) for an emailed verification code. */
  emailCodeTtlMs: number;
  /** Stripe publishable key (public; for Stripe.js) — present when signup is enabled. */
  stripePublishableKey?: string;
  /** Captcha config for the public signup. */
  captcha: { provider: 'none' | 'turnstile'; secret?: string; siteKey?: string };
  /** Port for the HTTP entrypoint. */
  port: number;
  /**
   * Non-fatal startup advisories surfaced by {@link loadConfig} — operational footguns that are
   * still valid configurations (so they must NOT fail closed), e.g. an in-memory rate-limit /
   * idempotency store in production (fine single-replica, unsafe multi-replica — gap #12). The
   * entrypoint logs these at startup (topic-config-environments); empty when there are none.
   */
  warnings: string[];
}

/**
 * Load and validate configuration from the environment.
 *
 * @param env - The environment to read (defaults to `process.env`).
 * @returns The validated configuration.
 * @throws ZodError if required variables are missing or invalid.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.parse(env);
  const config: Config = {
    databaseUrl: parsed.DATABASE_URL,
    neonApiKey: parsed.NEON_API_KEY,
    neonOrgId: parsed.NEON_ORG_ID,
    defaultRegion: parsed.TENANTFORGE_DEFAULT_REGION,
    allowedRegions: parsed.TENANTFORGE_ALLOWED_REGIONS,
    allowInsecureDb: parsed.TENANTFORGE_ALLOW_INSECURE_DB,
    allowInsecureUrls: parsed.TENANTFORGE_ALLOW_INSECURE_URLS,
    env: parsed.TENANTFORGE_ENV,
    ...(parsed.TENANTFORGE_ERASURE_SIGNING_KEY !== undefined
      ? { erasureSigningKey: parsed.TENANTFORGE_ERASURE_SIGNING_KEY }
      : {}),
    ...(parsed.TENANTFORGE_COMPLIANCE_SIGNING_KEY !== undefined
      ? { complianceSigningKey: parsed.TENANTFORGE_COMPLIANCE_SIGNING_KEY }
      : {}),
    secretBackend: parsed.TENANTFORGE_SECRET_BACKEND,
    exporter: parsed.TENANTFORGE_EXPORTER,
    retentionDays: parsed.TENANTFORGE_RETENTION_DAYS,
    queuePollMs: parsed.TENANTFORGE_QUEUE_POLL_MS,
    rateLimit: {
      limit: parsed.TENANTFORGE_RATE_LIMIT,
      windowMs: parsed.TENANTFORGE_RATE_WINDOW_MS,
    },
    rateLimitStore: parsed.TENANTFORGE_RATE_LIMIT_STORE,
    idempotencyStore: parsed.TENANTFORGE_IDEMPOTENCY_STORE,
    pendingErasureStore: parsed.TENANTFORGE_PENDING_ERASURE_STORE,
    evidenceStore: parsed.TENANTFORGE_EVIDENCE_STORE,
    evidenceRetentionDays: parsed.TENANTFORGE_EVIDENCE_RETENTION_DAYS,
    auditLog: parsed.TENANTFORGE_AUDIT_LOG,
    creditLedger: parsed.TENANTFORGE_CREDIT_LEDGER,
    signupTokenStore: parsed.TENANTFORGE_SIGNUP_TOKEN_STORE,
    usageAlertThresholds: parsed.TENANTFORGE_USAGE_ALERT_THRESHOLDS,
    paymentGateway: parsed.TENANTFORGE_PAYMENT_GATEWAY,
    notifier: parsed.TENANTFORGE_NOTIFIER,
    signupStore: parsed.TENANTFORGE_SIGNUP_STORE,
    emailCodeTtlMs: parsed.TENANTFORGE_EMAIL_CODE_TTL_MS,
    captcha: {
      provider: parsed.TENANTFORGE_CAPTCHA_PROVIDER,
      ...(parsed.TENANTFORGE_CAPTCHA_SECRET !== undefined
        ? { secret: parsed.TENANTFORGE_CAPTCHA_SECRET }
        : {}),
      ...(parsed.TENANTFORGE_CAPTCHA_SITE_KEY !== undefined
        ? { siteKey: parsed.TENANTFORGE_CAPTCHA_SITE_KEY }
        : {}),
    },
    ...(parsed.TENANTFORGE_SIGNUP_SECRET !== undefined
      ? { signupSecret: parsed.TENANTFORGE_SIGNUP_SECRET }
      : {}),
    ...(parsed.STRIPE_PUBLISHABLE_KEY !== undefined
      ? { stripePublishableKey: parsed.STRIPE_PUBLISHABLE_KEY }
      : {}),
    ...(parsed.STRIPE_SECRET_KEY !== undefined
      ? { stripeSecretKey: parsed.STRIPE_SECRET_KEY }
      : {}),
    ...(parsed.STRIPE_API_BASE_URL !== undefined
      ? { stripeApiBaseUrl: parsed.STRIPE_API_BASE_URL }
      : {}),
    ...(parsed.TENANTFORGE_PAYMENT_WEBHOOK_SECRET !== undefined
      ? { paymentWebhookSecret: parsed.TENANTFORGE_PAYMENT_WEBHOOK_SECRET }
      : {}),
    connectionCacheTtlMs: parsed.TENANTFORGE_CONNECTION_CACHE_TTL_MS,
    authMode: parsed.TENANTFORGE_AUTH_MODE,
    portalAuthMode: parsed.TENANTFORGE_PORTAL_AUTH_MODE,
    portalSelfServeDestructive: parsed.TENANTFORGE_PORTAL_SELFSERVE_DESTRUCTIVE,
    portalSelfServeEvidence: parsed.TENANTFORGE_PORTAL_SELFSERVE_EVIDENCE,
    stepUpCodeTtlMs: parsed.TENANTFORGE_PORTAL_STEPUP_TTL_MS,
    erasureUndoWindowMs: parsed.TENANTFORGE_PORTAL_ERASURE_UNDO_WINDOW_MS,
    port: parsed.TENANTFORGE_PORT,
    warnings: [],
    ...(parsed.TENANTFORGE_DASHBOARD_SECRET !== undefined
      ? { dashboardSecret: parsed.TENANTFORGE_DASHBOARD_SECRET }
      : {}),
    ...(parsed.TENANTFORGE_MIGRATIONS_DIR !== undefined
      ? { migrationsDir: parsed.TENANTFORGE_MIGRATIONS_DIR }
      : {}),
    ...(parsed.TENANTFORGE_DASHBOARD_DIST !== undefined
      ? { dashboardDist: parsed.TENANTFORGE_DASHBOARD_DIST }
      : {}),
    ...(parsed.TENANTFORGE_SIGNUP_DIST !== undefined
      ? { signupDist: parsed.TENANTFORGE_SIGNUP_DIST }
      : {}),
    ...(parsed.TENANTFORGE_PORTAL_DIST !== undefined
      ? { portalDist: parsed.TENANTFORGE_PORTAL_DIST }
      : {}),
    ...(parsed.TENANTFORGE_PORTAL_SECRET !== undefined
      ? { portalSecret: parsed.TENANTFORGE_PORTAL_SECRET }
      : {}),
  };

  if (parsed.TENANTFORGE_COST_RATES !== undefined) {
    let raw: unknown;
    try {
      raw = JSON.parse(parsed.TENANTFORGE_COST_RATES);
    } catch {
      throw new Error('TENANTFORGE_COST_RATES must be valid JSON');
    }
    config.costRates = CostRatesSchema.parse(raw) as CostRates;
  }
  if (parsed.TENANTFORGE_BILLING_RATES !== undefined) {
    let raw: unknown;
    try {
      raw = JSON.parse(parsed.TENANTFORGE_BILLING_RATES);
    } catch {
      throw new Error('TENANTFORGE_BILLING_RATES must be valid JSON');
    }
    config.billingRates = CostRatesSchema.parse(raw) as BillingRates;
  }
  if (parsed.TENANTFORGE_PLANS !== undefined) {
    let raw: unknown;
    try {
      raw = JSON.parse(parsed.TENANTFORGE_PLANS);
    } catch {
      throw new Error('TENANTFORGE_PLANS must be valid JSON');
    }
    if (!Array.isArray(raw)) throw new Error('TENANTFORGE_PLANS must be a JSON array of plans');
    // Fail loud on a malformed catalog (authored config) — assertPlanCatalog validates ids + numbers.
    config.plans = assertPlanCatalog(raw as PlanDefinition[]);
  }
  if (parsed.TENANTFORGE_PAYMENT_GATEWAY === 'stripe' && parsed.STRIPE_SECRET_KEY === undefined) {
    throw new Error('STRIPE_SECRET_KEY is required when TENANTFORGE_PAYMENT_GATEWAY=stripe');
  }
  // A captcha provider needs both keys (server secret + public site key).
  if (
    parsed.TENANTFORGE_CAPTCHA_PROVIDER !== 'none' &&
    parsed.TENANTFORGE_CAPTCHA_SECRET === undefined
  ) {
    throw new Error(
      'TENANTFORGE_CAPTCHA_SECRET is required when TENANTFORGE_CAPTCHA_PROVIDER is set',
    );
  }
  // Self-serve signup (enabled by TENANTFORGE_SIGNUP_SECRET) is payment-gated + abuse-gated: it
  // fails closed at config time unless Stripe, a captcha, and a notifier are all configured.
  if (parsed.TENANTFORGE_SIGNUP_SECRET !== undefined) {
    if (parsed.TENANTFORGE_PAYMENT_GATEWAY !== 'stripe') {
      throw new Error('self-serve signup requires TENANTFORGE_PAYMENT_GATEWAY=stripe');
    }
    if (parsed.STRIPE_PUBLISHABLE_KEY === undefined) {
      throw new Error('self-serve signup requires STRIPE_PUBLISHABLE_KEY (for Stripe.js)');
    }
    if (
      parsed.TENANTFORGE_CAPTCHA_PROVIDER === 'none' ||
      parsed.TENANTFORGE_CAPTCHA_SITE_KEY === undefined
    ) {
      throw new Error(
        'self-serve signup requires a captcha (TENANTFORGE_CAPTCHA_PROVIDER + _SECRET + _SITE_KEY)',
      );
    }
    if (parsed.TENANTFORGE_NOTIFIER === 'none') {
      throw new Error(
        'self-serve signup requires a notifier (TENANTFORGE_NOTIFIER=log|http) for email verification',
      );
    }
  }
  if (parsed.TENANTFORGE_AUTH_MODE === 'oidc') {
    // superRefine guarantees issuer/audience/jwksUri are present for this mode.
    config.oidc = {
      issuer: parsed.TENANTFORGE_OIDC_ISSUER!,
      audience: parsed.TENANTFORGE_OIDC_AUDIENCE!,
      jwksUri: parsed.TENANTFORGE_OIDC_JWKS_URI!,
      subjectClaim: parsed.TENANTFORGE_OIDC_SUBJECT_CLAIM,
      roleClaim: parsed.TENANTFORGE_OIDC_ROLE_CLAIM,
      ...(parsed.TENANTFORGE_OIDC_PERMISSIONS_CLAIM !== undefined
        ? { permissionsClaim: parsed.TENANTFORGE_OIDC_PERMISSIONS_CLAIM }
        : {}),
    };
  }
  const httpCredentials = parseHttpCredentials(parsed.TENANTFORGE_HTTP_CREDENTIALS);
  if (httpCredentials !== undefined) {
    config.httpCredentials = httpCredentials;
  }
  const portalCredentials = parseTenantCredentials(parsed.TENANTFORGE_PORTAL_CREDENTIALS);
  if (portalCredentials !== undefined) {
    config.portalCredentials = portalCredentials;
  }
  if (parsed.TENANTFORGE_NOTIFIER === 'http') {
    // superRefine guarantees the URL is present for this mode.
    config.notifierHttp = {
      url: parsed.TENANTFORGE_NOTIFIER_URL!,
      ...(parsed.TENANTFORGE_NOTIFIER_SECRET !== undefined
        ? { secret: parsed.TENANTFORGE_NOTIFIER_SECRET }
        : {}),
    };
  }
  if (parsed.TENANTFORGE_OPERATOR_EMAIL !== undefined) {
    config.operatorEmail = parsed.TENANTFORGE_OPERATOR_EMAIL;
  }
  if (parsed.TENANTFORGE_PORTAL_AUTH_MODE === 'oidc') {
    // superRefine guarantees issuer/audience/jwks + the code-flow endpoints are present for this mode.
    config.portalOidc = {
      issuer: parsed.TENANTFORGE_PORTAL_OIDC_ISSUER!,
      audience: parsed.TENANTFORGE_PORTAL_OIDC_AUDIENCE!,
      jwksUri: parsed.TENANTFORGE_PORTAL_OIDC_JWKS_URI!,
      tenantClaim: parsed.TENANTFORGE_PORTAL_OIDC_TENANT_CLAIM,
      authorizeUrl: parsed.TENANTFORGE_PORTAL_OIDC_AUTHORIZE_URL!,
      tokenUrl: parsed.TENANTFORGE_PORTAL_OIDC_TOKEN_URL!,
      redirectUri: parsed.TENANTFORGE_PORTAL_OIDC_REDIRECT_URI!,
      clientId:
        parsed.TENANTFORGE_PORTAL_OIDC_CLIENT_ID ?? parsed.TENANTFORGE_PORTAL_OIDC_AUDIENCE!,
      scope: parsed.TENANTFORGE_PORTAL_OIDC_SCOPE,
      ...(parsed.TENANTFORGE_PORTAL_OIDC_CLIENT_SECRET !== undefined
        ? { clientSecret: parsed.TENANTFORGE_PORTAL_OIDC_CLIENT_SECRET }
        : {}),
    };
  }
  if (parsed.TENANTFORGE_SECRET_KEY !== undefined) {
    config.secretKey = parsed.TENANTFORGE_SECRET_KEY;
  }
  if (parsed.TENANTFORGE_SECRET_BACKEND === 'vault') {
    // superRefine guarantees VAULT_ADDR + VAULT_TOKEN are present for this backend.
    config.vault = {
      address: parsed.VAULT_ADDR!,
      token: parsed.VAULT_TOKEN!,
      mount: parsed.VAULT_KV_MOUNT,
      pathPrefix: parsed.VAULT_PATH_PREFIX,
      ...(parsed.VAULT_NAMESPACE !== undefined ? { namespace: parsed.VAULT_NAMESPACE } : {}),
    };
  }
  if (parsed.TENANTFORGE_EXPORTER === 'pg-dump') {
    // superRefine guarantees TENANTFORGE_EXPORT_DIR is present for this exporter.
    config.exportDir = parsed.TENANTFORGE_EXPORT_DIR!;
  }
  if (parsed.TENANTFORGE_WEBHOOK_URL !== undefined) {
    // superRefine guarantees the secret is present alongside the URL.
    config.webhook = {
      url: parsed.TENANTFORGE_WEBHOOK_URL,
      secret: parsed.TENANTFORGE_WEBHOOK_SECRET!,
      ...(parsed.TENANTFORGE_WEBHOOK_EVENTS !== undefined
        ? { eventTypes: parsed.TENANTFORGE_WEBHOOK_EVENTS }
        : {}),
    };
  }
  if (parsed.NEON_API_BASE_URL !== undefined) {
    config.neonApiBaseUrl = parsed.NEON_API_BASE_URL;
  }
  if (parsed.TENANTFORGE_HTTP_TOKEN !== undefined && parsed.TENANTFORGE_HTTP_TOKEN !== '') {
    config.httpToken = parsed.TENANTFORGE_HTTP_TOKEN;
  }
  // Non-fatal multi-replica readiness advisory (gap #12). In-memory rate-limit / idempotency stores
  // are VALID single-replica in production, but the process can't know its replica count — so this is
  // a WARNING, not a fail-closed throw (which would break legitimate single-replica prod). In
  // multi-replica production an in-memory rate-limit store can't enforce a GLOBAL limit (each replica
  // counts independently) and in-memory idempotency replay-protection is per-instance (a retry on
  // another replica re-executes). The entrypoint logs these at startup.
  if (config.env === 'production') {
    if (config.rateLimitStore === 'memory') {
      config.warnings.push(
        'TENANTFORGE_RATE_LIMIT_STORE=memory in production: an in-memory rate-limit store cannot ' +
          'enforce a global limit across replicas (each replica counts independently) — set ' +
          'TENANTFORGE_RATE_LIMIT_STORE=pg for a multi-replica deployment.',
      );
    }
    if (config.idempotencyStore === 'memory') {
      config.warnings.push(
        'TENANTFORGE_IDEMPOTENCY_STORE=memory in production: in-memory idempotency replay-protection ' +
          'is per-instance (a POST retry landing on another replica re-executes) — set ' +
          'TENANTFORGE_IDEMPOTENCY_STORE=pg for a multi-replica deployment.',
      );
    }
  }
  return config;
}
