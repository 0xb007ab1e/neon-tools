import { describe, expect, it } from 'vitest';
import { createHttpServer } from '../../src/app/http-server.js';
import type { TenantForge } from '../../src/app/lib.js';

const TOKEN = 'test-token';
const fakeTf = (overrides: Partial<TenantForge>): TenantForge =>
  overrides as unknown as TenantForge;
const app = (overrides: Partial<TenantForge> = {}) =>
  createHttpServer(fakeTf(overrides), { token: TOKEN });

describe('HTTP tracing / correlation', () => {
  it('echoes a generated x-correlation-id (W3C trace id) on every response', async () => {
    const res = await app({ listTenants: async () => [] }).request('/v1/tenants', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-correlation-id')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('sets the correlation id even on an unauthenticated route (the trace wraps every request)', async () => {
    const res = await app().request('/health');
    expect(res.headers.get('x-correlation-id')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('continues an inbound W3C traceparent (correlation id == inbound trace id)', async () => {
    const traceId = '0af7651916cd43dd8448eb211c80319c';
    const res = await app().request('/health', {
      headers: { traceparent: `00-${traceId}-b7ad6b7169203331-01` },
    });
    expect(res.headers.get('x-correlation-id')).toBe(traceId);
  });

  it('generates a fresh trace for a malformed inbound traceparent (fail closed)', async () => {
    const res = await app().request('/health', { headers: { traceparent: 'garbage' } });
    const cid = res.headers.get('x-correlation-id');
    expect(cid).toMatch(/^[0-9a-f]{32}$/);
    expect(cid).not.toBe('garbage');
  });
});
