import { describe, expect, it } from 'vitest';
import { createHttpServer } from '../../src/app/http-server.js';
import type { VectorNest } from '../../src/app/lib.js';

const TOKEN = 'test-token';
const fakeVn = (overrides: Partial<VectorNest>): VectorNest => overrides as unknown as VectorNest;
const app = (overrides: Partial<VectorNest> = {}) =>
  createHttpServer(fakeVn(overrides), { token: TOKEN });
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

describe('HTTP server', () => {
  it('serves /health without auth', async () => {
    const res = await app().request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', tool: 'vectornest' });
  });

  it('rejects /v1 routes without a bearer token (401)', async () => {
    const res = await app().request('/v1/collections');
    expect(res.status).toBe(401);
  });

  it('runs a query with a valid token + body', async () => {
    const hit = {
      chunkId: 'c1',
      documentId: 'd1',
      sourceUri: '/docs/neon.md',
      ordinal: 0,
      text: 'Neon scales to zero',
      score: 0.9,
      metadata: {},
    };
    const res = await app({ query: async () => [hit] }).request('/v1/query', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ text: 'idle cost?', mode: 'hybrid' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hits: [hit] });
  });

  it('returns RFC 9457 problem+json on validation failure (400)', async () => {
    const res = await app().request('/v1/query', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ k: 5 }), // missing required `text`
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(await res.json()).toMatchObject({ title: 'Validation failed', status: 400 });
  });

  it('lists collections', async () => {
    const res = await app({
      collections: async () => [{ id: 'c1', name: 'default', metadata: {} }],
    }).request('/v1/collections', { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      collections: [{ id: 'c1', name: 'default', metadata: {} }],
    });
  });

  it('maps "not registered" to 404 on activate', async () => {
    const res = await app({
      activateModel: async () => {
        throw new Error('model "ghost" is not registered');
      },
    }).request('/v1/models/ghost/activate', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { detail: string }).detail).toContain('is not registered');
  });
});
