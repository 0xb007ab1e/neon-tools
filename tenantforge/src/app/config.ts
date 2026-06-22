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
    // Portal OIDC mode needs its issuer/audience/JWKS (the static credentials aren't used then).
    if (env.TENANTFORGE_PORTAL_AUTH_MODE === 'oidc') {
      for (const key of [
        'TENANTFORGE_PORTAL_OIDC_ISSUER',
        'TENANTFORGE_PORTAL_OIDC_AUDIENCE',
        'TENANTFORGE_PORTAL_OIDC_JWKS_URI',
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
  /** Directory of ordered migration `.sql` files; set ⇒ the dashboard can execute a reconcile. */
  migrationsDir?: string;
  /** Portal session-cookie HMAC key; set (with `portalCredentials`) ⇒ the /portal is mounted. */
  portalSecret?: string;
  /** Static portal credentials (`tenantId` → token); set ⇒ the token tenant-authenticator is wired. */
  portalCredentials?: { tenantId: string; token: string }[];
  /** Portal auth mode: static `token` map or `oidc` (verify a customer-IdP JWT's tenant claim). */
  portalAuthMode: 'token' | 'oidc';
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
  /** Port for the HTTP entrypoint. */
  port: number;
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
    auditLog: parsed.TENANTFORGE_AUDIT_LOG,
    creditLedger: parsed.TENANTFORGE_CREDIT_LEDGER,
    signupTokenStore: parsed.TENANTFORGE_SIGNUP_TOKEN_STORE,
    usageAlertThresholds: parsed.TENANTFORGE_USAGE_ALERT_THRESHOLDS,
    paymentGateway: parsed.TENANTFORGE_PAYMENT_GATEWAY,
    notifier: parsed.TENANTFORGE_NOTIFIER,
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
    port: parsed.TENANTFORGE_PORT,
    ...(parsed.TENANTFORGE_DASHBOARD_SECRET !== undefined
      ? { dashboardSecret: parsed.TENANTFORGE_DASHBOARD_SECRET }
      : {}),
    ...(parsed.TENANTFORGE_MIGRATIONS_DIR !== undefined
      ? { migrationsDir: parsed.TENANTFORGE_MIGRATIONS_DIR }
      : {}),
    ...(parsed.TENANTFORGE_DASHBOARD_DIST !== undefined
      ? { dashboardDist: parsed.TENANTFORGE_DASHBOARD_DIST }
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
    // superRefine guarantees issuer/audience/jwks are present for this mode.
    config.portalOidc = {
      issuer: parsed.TENANTFORGE_PORTAL_OIDC_ISSUER!,
      audience: parsed.TENANTFORGE_PORTAL_OIDC_AUDIENCE!,
      jwksUri: parsed.TENANTFORGE_PORTAL_OIDC_JWKS_URI!,
      tenantClaim: parsed.TENANTFORGE_PORTAL_OIDC_TENANT_CLAIM,
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
  return config;
}
