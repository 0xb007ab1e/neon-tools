import { z } from 'zod';
import { KNOWN_REGIONS } from '../core/regions.js';

/**
 * Environment schema. Validated at startup so the process fails fast on misconfiguration
 * (12-Factor config). Secrets are read from the environment, never committed (workflow-secrets).
 */
const EnvSchema = z.object({
  // Control-plane registry (metadata only — never tenant data).
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // Neon API — provisions/deletes a project per tenant. The account is org-scoped.
  NEON_API_KEY: z.string().min(1, 'NEON_API_KEY is required'),
  NEON_ORG_ID: z.string().min(1, 'NEON_ORG_ID is required'),
  NEON_API_BASE_URL: z.string().url().optional(),
  // Encrypts per-tenant connection secrets at rest (AES-256-GCM). MUST be separate from
  // DATABASE_URL's credential (separation of duties) and high-entropy. Min 16 chars.
  TENANTFORGE_SECRET_KEY: z.string().min(16, 'TENANTFORGE_SECRET_KEY must be at least 16 chars'),
  // Default region for provisioning when a request omits one (validated against the allow-list).
  TENANTFORGE_DEFAULT_REGION: z
    .enum(KNOWN_REGIONS as [string, ...string[]])
    .default('aws-us-east-1'),
  // HTTP entrypoint (required only when running the HTTP server — a later milestone).
  TENANTFORGE_HTTP_TOKEN: z.string().optional(),
  TENANTFORGE_PORT: z.coerce.number().int().positive().default(3000),
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
  /** Passphrase used to encrypt per-tenant connection secrets at rest (separate from the DB cred). */
  secretKey: string;
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
    secretKey: parsed.TENANTFORGE_SECRET_KEY,
    port: parsed.TENANTFORGE_PORT,
  };
  if (parsed.NEON_API_BASE_URL !== undefined) {
    config.neonApiBaseUrl = parsed.NEON_API_BASE_URL;
  }
  if (parsed.TENANTFORGE_HTTP_TOKEN !== undefined && parsed.TENANTFORGE_HTTP_TOKEN !== '') {
    config.httpToken = parsed.TENANTFORGE_HTTP_TOKEN;
  }
  return config;
}
