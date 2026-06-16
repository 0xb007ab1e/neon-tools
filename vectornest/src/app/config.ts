import { z } from 'zod';
import { knownDimension } from '../core/model-registry.js';

/**
 * Environment schema. Validated at startup so the process fails fast on misconfiguration
 * (12-Factor config). Secrets are read from the environment, never committed.
 */
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  AI_GATEWAY_API_KEY: z.string().min(1, 'AI_GATEWAY_API_KEY is required'),
  VECTORNEST_MODEL: z.string().min(1).default('openai/text-embedding-3-small'),
  VECTORNEST_EMBED_DIM: z.coerce.number().int().positive().optional(),
  VECTORNEST_EMBED_BATCH_SIZE: z.coerce.number().int().positive().default(64),
});

/** Resolved, validated configuration. Holds no secrets beyond the DB URL needed to connect. */
export interface Config {
  /** Postgres connection string. */
  databaseUrl: string;
  /** Provider/model string for embeddings. */
  model: string;
  /** Embedding dimension (resolved from a known model or VECTORNEST_EMBED_DIM). */
  dim: number;
  /** Max texts per embedding request. */
  embedBatchSize: number;
}

/**
 * Load and validate configuration from the environment.
 *
 * `AI_GATEWAY_API_KEY` is validated as present (the AI Gateway client reads it directly) but is
 * not carried in the returned config, to limit secret propagation.
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
  return {
    databaseUrl: parsed.DATABASE_URL,
    model: parsed.VECTORNEST_MODEL,
    dim,
    embedBatchSize: parsed.VECTORNEST_EMBED_BATCH_SIZE,
  };
}
