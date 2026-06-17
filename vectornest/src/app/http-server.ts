import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import { z } from 'zod';
import { VECTORNEST } from '../meta.js';
import type { QueryRequest, VectorNest } from './lib.js';

/** Options for {@link createHttpServer}. */
export interface HttpServerOptions {
  /** Bearer token required on every `/v1/*` request. */
  token: string;
}

const QuerySchema = z.object({
  text: z.string().min(1),
  collection: z.string().min(1).optional(),
  k: z.number().int().min(1).max(100).optional(),
  mode: z.enum(['vector', 'keyword', 'hybrid']).optional(),
});

const EvalSchema = z.object({
  model: z.string().min(1),
  evalSet: z
    .array(z.object({ query: z.string().min(1), relevant: z.array(z.string().min(1)).min(1) }))
    .min(1),
  k: z.number().int().min(1).max(100).optional(),
});

/** Return an RFC 9457 problem+json response. */
function problem(c: Context, status: number, title: string, detail?: string) {
  return c.json(
    { type: 'about:blank', title, status, ...(detail !== undefined ? { detail } : {}) },
    status as 400,
    { 'content-type': 'application/problem+json' },
  );
}

/** Map a use-case error to a safe HTTP status; unexpected errors become a generic 500. */
function handleError(c: Context, error: unknown) {
  const message = error instanceof Error ? error.message : 'error';
  if (/is not registered/.test(message)) return problem(c, 404, 'Not Found', message);
  if (/no active embedding model|only \d+\/\d+|requires Neon|refusing to/.test(message)) {
    return problem(c, 409, 'Conflict', message);
  }
  // Unexpected (e.g. infrastructure): log server-side, never leak internals to the client.
  process.stderr.write(`vectornest http: ${message}\n`);
  return problem(c, 500, 'Internal Server Error');
}

/** Parse + validate a JSON body against a schema, returning a 400 problem on failure. */
async function readJson<T>(
  c: Context,
  schema: z.ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; res: Response }> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, res: problem(c, 400, 'Invalid JSON body') };
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { ok: false, res: problem(c, 400, 'Validation failed', detail) };
  }
  return { ok: true, data: result.data };
}

/**
 * Build the VectorNest HTTP API (a Hono app). Read + light-management surface: query, list
 * collections/models, activate a model, and evaluate. Ingest and re-embed are intentionally not
 * exposed (server-path-based / long-running — use the CLI or MCP). Every `/v1/*` route requires a
 * bearer token; the {@link VectorNest} service is injected so the app is testable without infra.
 *
 * @param vn - The VectorNest application service.
 * @param options - The bearer token to require.
 * @returns A configured Hono app (use its `.fetch` with a server, or `.request` in tests).
 */
export function createHttpServer(vn: VectorNest, options: HttpServerOptions): Hono {
  const app = new Hono();

  app.use('*', secureHeaders());

  app.get('/health', (c) =>
    c.json({ status: 'ok', tool: VECTORNEST.id, version: VECTORNEST.version }),
  );

  // Everything under /v1 requires auth and a bounded body.
  app.use('/v1/*', bearerAuth({ token: options.token }));
  app.use('/v1/*', bodyLimit({ maxSize: 1024 * 1024 }));

  app.post('/v1/query', async (c) => {
    const parsed = await readJson(c, QuerySchema);
    if (!parsed.ok) return parsed.res;
    const { text, collection, k, mode } = parsed.data;
    const request: QueryRequest = {
      ...(collection !== undefined ? { collection } : {}),
      ...(k !== undefined ? { k } : {}),
      ...(mode !== undefined ? { mode } : {}),
    };
    try {
      return c.json({ hits: await vn.query(text, request) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.get('/v1/collections', async (c) => {
    try {
      return c.json({ collections: await vn.collections() });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.get('/v1/models', async (c) => {
    try {
      return c.json({ models: await vn.models() });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.post('/v1/models/:name/activate', async (c) => {
    const name = c.req.param('name');
    try {
      await vn.activateModel(name);
      return c.json({ model: name, active: true });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.post('/v1/eval', async (c) => {
    const parsed = await readJson(c, EvalSchema);
    if (!parsed.ok) return parsed.res;
    const { model, evalSet, k } = parsed.data;
    try {
      const result = await vn.evaluate(model, evalSet, k !== undefined ? { k } : {});
      return c.json({
        model: result.model,
        ...result.report,
        elapsedMs: result.elapsedMs,
        passed: result.passed,
      });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.notFound((c) => problem(c, 404, 'Not Found'));
  app.onError((error, c) => {
    // Preserve framework HTTP errors (e.g. bearerAuth 401, bodyLimit 413).
    if (error instanceof HTTPException) return error.getResponse();
    return handleError(c, error);
  });

  return app;
}
