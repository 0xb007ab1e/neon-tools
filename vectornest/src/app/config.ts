import { z } from 'zod';
import { knownDimension } from '../core/model-registry.js';

/**
 * Environment schema. Validated at startup so the process fails fast on misconfiguration
 * (12-Factor config). Secrets are read from the environment, never committed.
 */
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  EMBEDDINGS_BASE_URL: z.string().url('EMBEDDINGS_BASE_URL must be a URL'),
  EMBEDDINGS_API_KEY: z.string().optional(),
  VECTORNEST_MODEL: z.string().min(1).default('@cf/baai/bge-base-en-v1.5'),
  VECTORNEST_EMBED_DIM: z.coerce.number().int().positive().optional(),
  VECTORNEST_EMBED_BATCH_SIZE: z.coerce.number().int().positive().default(64),
  // Optional — only needed for branch rehearsal (creating/deleting Neon branches).
  NEON_API_KEY: z.string().optional(),
  NEON_PROJECT_ID: z.string().optional(),
  NEON_API_BASE_URL: z.string().url().optional(),
});

/** Resolved, validated configuration. */
export interface Config {
  /** Postgres connection string. */
  databaseUrl: string;
  /** OpenAI-compatible embeddings base URL (includes the `/v1` segment). */
  embeddingsBaseUrl: string;
  /** Optional bearer token for the embeddings endpoint (omit for keyless local servers). */
  embeddingsApiKey?: string;
  /** Provider/model string for embeddings. */
  model: string;
  /** Embedding dimension (resolved from a known model or VECTORNEST_EMBED_DIM). */
  dim: number;
  /** Max texts per embedding request. */
  embedBatchSize: number;
  /** Neon API key — enables branch rehearsal when set with a project id. */
  neonApiKey?: string;
  /** Neon project id for branch operations. */
  neonProjectId?: string;
  /** Neon API base URL (defaults to the public API). */
  neonApiBaseUrl?: string;
}

/**
 * Load and validate configuration from the environment.
 *
 * @param env - The environment to read (defaults to `process.env`).
 * @returns The validated configuration.
 * @throws ZodError if required variables are missing/invalid, or Error if the dimension is unknown.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.parse(env);
  const dim = parsed.VECTORNEST_EMBED_DIM ?? knownDimension(parsed.VECTORNEST_MODEL);
  if (dim === undefined) {
    throw new Error(
      `unknown embedding dimension for "${parsed.VECTORNEST_MODEL}"; set VECTORNEST_EMBED_DIM`,
    );
  }
  const config: Config = {
    databaseUrl: parsed.DATABASE_URL,
    embeddingsBaseUrl: parsed.EMBEDDINGS_BASE_URL,
    model: parsed.VECTORNEST_MODEL,
    dim,
    embedBatchSize: parsed.VECTORNEST_EMBED_BATCH_SIZE,
  };
  if (parsed.EMBEDDINGS_API_KEY !== undefined && parsed.EMBEDDINGS_API_KEY !== '') {
    config.embeddingsApiKey = parsed.EMBEDDINGS_API_KEY;
  }
  if (parsed.NEON_API_KEY !== undefined && parsed.NEON_API_KEY !== '') {
    config.neonApiKey = parsed.NEON_API_KEY;
  }
  if (parsed.NEON_PROJECT_ID !== undefined && parsed.NEON_PROJECT_ID !== '') {
    config.neonProjectId = parsed.NEON_PROJECT_ID;
  }
  if (parsed.NEON_API_BASE_URL !== undefined) {
    config.neonApiBaseUrl = parsed.NEON_API_BASE_URL;
  }
  return config;
}
