import { z } from 'zod';
import { KNOWN_REGIONS } from '../core/regions.js';

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
    // Retention window (days) an archived (offboarding) tenant is kept before the purge sweep.
    TENANTFORGE_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(30),
    // Worker poll interval (ms) between lifecycle-queue drains.
    TENANTFORGE_QUEUE_POLL_MS: z.coerce.number().int().positive().default(5000),
    // HTTP entrypoint (required only when running the HTTP server — a later milestone).
    TENANTFORGE_HTTP_TOKEN: z.string().optional(),
    TENANTFORGE_PORT: z.coerce.number().int().positive().default(3000),
  })
  .superRefine((env, ctx) => {
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
  /** Retention window (days) before an archived tenant is purged. */
  retentionDays: number;
  /** Worker poll interval (ms) between lifecycle-queue drains. */
  queuePollMs: number;
  /** Bearer token for the HTTP entrypoint (required only when serving HTTP). */
  httpToken?: string;
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
    secretBackend: parsed.TENANTFORGE_SECRET_BACKEND,
    retentionDays: parsed.TENANTFORGE_RETENTION_DAYS,
    queuePollMs: parsed.TENANTFORGE_QUEUE_POLL_MS,
    port: parsed.TENANTFORGE_PORT,
  };
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
  if (parsed.NEON_API_BASE_URL !== undefined) {
    config.neonApiBaseUrl = parsed.NEON_API_BASE_URL;
  }
  if (parsed.TENANTFORGE_HTTP_TOKEN !== undefined && parsed.TENANTFORGE_HTTP_TOKEN !== '') {
    config.httpToken = parsed.TENANTFORGE_HTTP_TOKEN;
  }
  return config;
}
