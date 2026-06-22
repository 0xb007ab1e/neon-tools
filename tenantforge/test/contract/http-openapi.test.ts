// Contract tests for the HTTP control-plane (master §4: contract tests for every public API).
// They assert the running server honors its published contract — `openapi.yaml` — in two ways:
//   1. Route inventory: the set of served routes equals the set of documented routes, in both
//      directions. Catches undocumented "shadow" endpoints and documented-but-unimplemented ones
//      (OWASP API9 — improper inventory management).
//   2. Response-shape conformance: representative responses validate against the OpenAPI response
//      schema for that path/method/status (resolved with `$ref`s), so the wire shape can't drift
//      from the spec silently.
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { createHttpServer } from '../../src/app/http-server.js';
import type { TenantForge } from '../../src/app/lib.js';
import type { TenantRecord } from '../../src/core/domain.js';

/** Minimal structural view of the slice of OpenAPI 3.1 this test navigates. */
interface SchemaObject {
  $ref?: string;
  [k: string]: unknown;
}
interface ResponseObject {
  $ref?: string;
  content?: Record<string, { schema: SchemaObject }>;
}
interface Operation {
  responses: Record<string, ResponseObject>;
}
interface OpenApiDoc {
  paths: Record<string, Record<string, Operation>>;
  components: Record<string, unknown>;
}

const doc = parseYaml(
  readFileSync(new URL('../../openapi.yaml', import.meta.url), 'utf8'),
) as OpenApiDoc;

// Lenient parse (validateSchema:false / strict:false): the OpenAPI document carries annotations and
// 3.1 idioms (e.g. `type: [string, 'null']`, `const`) that aren't worth meta-validating here — we
// only compile the individual response schemas to check instances against them.
// `logger: false` silences ajv's "unknown format date-time" notices — we validate structure/types,
// not string formats (no ajv-formats dep), so format keywords are intentionally annotation-only.
const ajv = new Ajv2020({ strict: false, validateSchema: false, allErrors: true, logger: false });

/** Follow a local JSON pointer (`#/a/b`) within the document. */
function deref<T>(ref: string): T {
  const segments = ref
    .replace(/^#\//, '')
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur: unknown = doc;
  for (const seg of segments) cur = (cur as Record<string, unknown>)[seg];
  return cur as T;
}

/** The JSON-schema for a documented response, with the response-level `$ref` (if any) resolved. */
function responseSchema(path: string, method: string, status: string): SchemaObject {
  let response = doc.paths[path]?.[method]?.responses[status];
  if (!response) throw new Error(`no documented response ${method} ${path} ${status}`);
  if (response.$ref) response = deref<ResponseObject>(response.$ref);
  const content = response.content ?? {};
  const media = content['application/json'] ?? content['application/problem+json'];
  if (!media) throw new Error(`no JSON content for ${method} ${path} ${status}`);
  return media.schema;
}

/**
 * Validate `data` against a response schema. The schema's internal `#/components/...` refs resolve
 * against a root that carries the document's `components` (in 2020-12 a `$ref` may have siblings, so
 * this works whether the response schema is inline or itself a `$ref`).
 */
function validate(schema: SchemaObject, data: unknown): string[] {
  const validateFn = ajv.compile({ ...schema, components: doc.components });
  if (validateFn(data)) return [];
  return (validateFn.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim());
}

const TOKEN = 'test-token';
const fakeTf = (overrides: Partial<TenantForge>): TenantForge =>
  overrides as unknown as TenantForge;
const app = (overrides: Partial<TenantForge> = {}) =>
  createHttpServer(fakeTf(overrides), { token: TOKEN });
const auth = { authorization: `Bearer ${TOKEN}` };

const tenant: TenantRecord = {
  id: 't1',
  slug: 'acme',
  region: 'aws-us-east-1',
  status: 'active',
  neonProjectId: 'proj-1',
  metadata: {},
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const HTTP_VERBS = new Set(['get', 'post', 'put', 'delete', 'patch']);

describe('HTTP ↔ OpenAPI contract', () => {
  it('serves exactly the documented routes (no shadow or zombie endpoints — API9)', () => {
    const documented = new Set<string>();
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const method of Object.keys(item)) {
        if (HTTP_VERBS.has(method)) {
          // OpenAPI `{id}` path templating → Hono `:id`.
          documented.add(`${method.toUpperCase()} ${path.replace(/\{([^}]+)\}/g, ':$1')}`);
        }
      }
    }

    // Build with every documented-but-conditional surface enabled (the inbound PSP webhook) so the
    // served set is the complete contract. `/metrics` stays off — it's an operational scrape
    // endpoint deliberately absent from the public spec.
    const server = createHttpServer(fakeTf({}), { token: TOKEN, paymentWebhooks: true });
    const served = new Set<string>();
    for (const route of server.routes) {
      const method = route.method.toLowerCase();
      if (!HTTP_VERBS.has(method)) continue; // skip `ALL` (middleware)
      if (route.path.includes('*')) continue; // skip wildcard middleware mounts
      served.add(`${route.method.toUpperCase()} ${route.path}`);
    }

    expect([...served].sort()).toEqual([...documented].sort());
  });

  // Representative responses across the reused shapes: a plain object, a component object, an
  // array-of-component envelope, and the RFC 9457 problem envelope (401/404). Validating these
  // exercises the shared `Tenant`/`Problem`/`HealthReport` schemas every other endpoint reuses.
  const cases: Array<{
    name: string;
    server: ReturnType<typeof app>;
    request: string;
    headers: Record<string, string>;
    path: string;
    method: string;
    status: string;
  }> = [
    {
      name: 'GET /health → 200',
      server: app(),
      request: '/health',
      headers: {},
      path: '/health',
      method: 'get',
      status: '200',
    },
    {
      name: 'GET /ready → 200',
      server: app({ health: async () => ({ status: 'ok', checks: { registry: 'ok' } }) }),
      request: '/ready',
      headers: {},
      path: '/ready',
      method: 'get',
      status: '200',
    },
    {
      name: 'GET /v1/tenants → 200',
      server: app({ listTenants: async () => [tenant] }),
      request: '/v1/tenants',
      headers: auth,
      path: '/v1/tenants',
      method: 'get',
      status: '200',
    },
    {
      name: 'GET /v1/tenants/{id} → 200',
      server: app({ getTenant: async () => tenant }),
      request: '/v1/tenants/t1',
      headers: auth,
      path: '/v1/tenants/{id}',
      method: 'get',
      status: '200',
    },
    {
      name: 'GET /v1/tenants/{id} → 404 (problem envelope)',
      server: app({ getTenant: async () => null }),
      request: '/v1/tenants/nope',
      headers: auth,
      path: '/v1/tenants/{id}',
      method: 'get',
      status: '404',
    },
    {
      name: 'GET /v1/tenants → 401 (problem envelope)',
      server: app(),
      request: '/v1/tenants',
      headers: {},
      path: '/v1/tenants',
      method: 'get',
      status: '401',
    },
  ];

  for (const c of cases) {
    it(`${c.name} conforms to its documented schema`, async () => {
      const res = await c.server.request(c.request, { headers: c.headers });
      expect(String(res.status)).toBe(c.status);
      const errors = validate(responseSchema(c.path, c.method, c.status), await res.json());
      expect(errors).toEqual([]);
    });
  }

  it('the schema validator actually rejects a non-conforming body (the gate is real)', () => {
    // `id` must be a string and every Tenant field is required — this body violates both.
    const errors = validate(responseSchema('/v1/tenants', 'get', '200'), {
      tenants: [{ id: 123 }],
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});
