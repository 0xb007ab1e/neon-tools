import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import { z } from 'zod';
import { TENANTFORGE } from '../meta.js';
import type { JsonObject, TenantStatus } from '../core/index.js';
import type { TenantForge } from './lib.js';

/** Options for {@link createHttpServer}. */
export interface HttpServerOptions {
  /** Bearer token required on every `/v1/*` request. */
  token: string;
}

const TENANT_STATUSES = ['provisioning', 'active', 'suspended', 'offboarding', 'deleted'] as const;

const ProvisionSchema = z.object({
  slug: z.string().min(1),
  region: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const OffboardSchema = z.object({
  // Defense in depth: an irreversible delete must be explicitly confirmed in the body.
  confirm: z.literal(true),
  skipExport: z.boolean().optional(),
  reason: z.string().min(1).optional(),
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
  if (/not found/.test(message)) return problem(c, 404, 'Not Found', message);
  if (/invalid tenant slug|unknown region|requires a reason/.test(message)) {
    return problem(c, 400, 'Bad Request', message);
  }
  if (/illegal tenant status transition|belongs to a|no exporter configured/.test(message)) {
    return problem(c, 409, 'Conflict', message);
  }
  // Unexpected (e.g. Neon API / registry failure): log server-side, never leak internals.
  process.stderr.write(`tenantforge http: ${message}\n`);
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
 * Build the TenantForge HTTP control-plane API (a Hono app): provision, list, get, and the
 * lifecycle operations (suspend / resume / offboard). Every `/v1/*` route requires a bearer token
 * and a bounded body; the {@link TenantForge} service is injected so the app is testable without
 * infrastructure.
 *
 * The tenant id in a path is the server's own identifier — authorization is the bearer token; a
 * production deployment derives the tenant scope from the authenticated principal, never trusting a
 * client-supplied id beyond this single-tenant-admin token model (std-owasp-api BOLA).
 *
 * @param tf - The TenantForge application service.
 * @param options - The bearer token to require.
 * @returns A configured Hono app (use its `.fetch` with a server, or `.request` in tests).
 */
export function createHttpServer(tf: TenantForge, options: HttpServerOptions): Hono {
  const app = new Hono();

  app.use('*', secureHeaders());

  app.get('/health', (c) =>
    c.json({ status: 'ok', tool: TENANTFORGE.id, version: TENANTFORGE.version }),
  );

  app.use('/v1/*', bearerAuth({ token: options.token }));
  app.use('/v1/*', bodyLimit({ maxSize: 1024 * 1024 }));

  app.post('/v1/tenants', async (c) => {
    const parsed = await readJson(c, ProvisionSchema);
    if (!parsed.ok) return parsed.res;
    const { slug, region, metadata } = parsed.data;
    try {
      const outcome = await tf.provision({
        slug,
        ...(region !== undefined ? { region } : {}),
        ...(metadata !== undefined ? { metadata: metadata as JsonObject } : {}),
      });
      // connectionUri is a secret delivered once to the authenticated caller; never logged.
      return c.json({ tenant: outcome.tenant, connectionUri: outcome.connectionUri }, 201);
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.get('/v1/tenants', async (c) => {
    const statusParam = c.req.query('status');
    if (statusParam !== undefined && !TENANT_STATUSES.includes(statusParam as TenantStatus)) {
      return problem(c, 400, 'Bad Request', `unknown status "${statusParam}"`);
    }
    const limitParam = c.req.query('limit');
    const limit = limitParam === undefined ? undefined : Number(limitParam);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      return problem(c, 400, 'Bad Request', 'limit must be a positive integer');
    }
    try {
      const tenants = await tf.listTenants({
        ...(statusParam !== undefined ? { status: statusParam as TenantStatus } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return c.json({ tenants });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.get('/v1/tenants/:id', async (c) => {
    try {
      const tenant = await tf.getTenant(c.req.param('id'));
      if (!tenant) return problem(c, 404, 'Not Found');
      return c.json({ tenant });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.post('/v1/tenants/:id/suspend', async (c) => {
    try {
      return c.json({ tenant: await tf.suspend(c.req.param('id')) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.post('/v1/tenants/:id/resume', async (c) => {
    try {
      return c.json({ tenant: await tf.resume(c.req.param('id')) });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.post('/v1/tenants/:id/offboard', async (c) => {
    const parsed = await readJson(c, OffboardSchema);
    if (!parsed.ok) return parsed.res;
    const { skipExport, reason } = parsed.data;
    try {
      const outcome = await tf.offboard(c.req.param('id'), {
        ...(skipExport !== undefined ? { skipExport } : {}),
        ...(reason !== undefined ? { reason } : {}),
      });
      return c.json({ tenant: outcome.tenant, export: outcome.export });
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
