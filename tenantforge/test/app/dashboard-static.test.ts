import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpServer } from '../../src/app/http-server.js';
import type { TenantForge } from '../../src/app/lib.js';

const TOKEN = 'op-token';
const fakeTf = (o: Partial<TenantForge>): TenantForge => o as unknown as TenantForge;

// A throwaway built-SPA fixture: index.html + a hashed asset, mirroring `dashboard/dist`.
let dist: string;
beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), 'tf-dash-dist-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>TenantForge</title><div id=root>');
  writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'console.log("spa")');
});
afterAll(() => rmSync(dist, { recursive: true, force: true }));

const server = () =>
  createHttpServer(fakeTf({}), {
    token: TOKEN,
    dashboardSecret: 'dashboard-session-secret-0123456789',
    dashboardStaticRoot: dist,
  });

describe('dashboard static SPA serving', () => {
  it('serves index.html at the dashboard root', async () => {
    const res = await server().request('/dashboard/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toContain('<div id=root>');
  });

  it('serves a hashed asset', async () => {
    const res = await server().request('/dashboard/assets/app-abc123.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('console.log("spa")');
  });

  it('falls back to index.html for an unknown client-side path (SPA routing)', async () => {
    const res = await server().request('/dashboard/some/deep/route');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id=root>');
  });

  it('does not let static serving shadow the JSON API (still 401 without a session)', async () => {
    const res = await server().request('/dashboard/api/session');
    expect(res.status).toBe(401);
  });

  it('serves JSON API only when no static root is configured (root 404)', async () => {
    const apiOnly = createHttpServer(fakeTf({}), {
      token: TOKEN,
      dashboardSecret: 'dashboard-session-secret-0123456789',
    });
    expect((await apiOnly.request('/dashboard/')).status).toBe(404);
  });
});
