import { describe, expect, it, vi } from 'vitest';
import { createNeonBranchManager } from '../../src/adapters/neon-api/branch-manager.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const asFetch = (fn: unknown): typeof fetch => fn as typeof fetch;

const branchBody = {
  branch: { id: 'br_123' },
  connection_uris: [{ connection_uri: 'postgresql://u:p@br.neon.tech/db?sslmode=require' }],
};

describe('createNeonBranchManager.createBranch', () => {
  it('POSTs to the project branches endpoint with auth and returns id + uri', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchImpl = vi.fn((url: string, init: RequestInit) => {
      calls.push([url, init]);
      return Promise.resolve(jsonResponse(branchBody));
    });
    const mgr = createNeonBranchManager({
      apiKey: 'neon_key',
      projectId: 'proj_1',
      baseUrl: 'https://api.example/v2/',
      fetchImpl: asFetch(fetchImpl),
    });

    const result = await mgr.createBranch('rehearse-1');
    expect(result).toEqual({
      branchId: 'br_123',
      connectionUri: 'postgresql://u:p@br.neon.tech/db?sslmode=require',
    });
    const [url, init] = calls[0]!;
    expect(url).toBe('https://api.example/v2/projects/proj_1/branches'); // trailing slash trimmed
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer neon_key');
  });

  it('throws on a non-2xx response with the status', async () => {
    const mgr = createNeonBranchManager({
      apiKey: 'k',
      projectId: 'p',
      fetchImpl: asFetch(() => Promise.resolve(jsonResponse({ message: 'nope' }, 403))),
    });
    await expect(mgr.createBranch('x')).rejects.toThrow(/HTTP 403/);
  });

  it('throws when no connection URI is returned', async () => {
    const mgr = createNeonBranchManager({
      apiKey: 'k',
      projectId: 'p',
      fetchImpl: asFetch(() =>
        Promise.resolve(jsonResponse({ branch: { id: 'br' }, connection_uris: [] })),
      ),
    });
    await expect(mgr.createBranch('x')).rejects.toThrow();
  });
});

describe('createNeonBranchManager.deleteBranch', () => {
  it('DELETEs the branch and tolerates a 204', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchImpl = vi.fn((url: string, init: RequestInit) => {
      calls.push([url, init]);
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const mgr = createNeonBranchManager({
      apiKey: 'k',
      projectId: 'p',
      fetchImpl: asFetch(fetchImpl),
    });

    await expect(mgr.deleteBranch('br_9')).resolves.toBeUndefined();
    const [url, init] = calls[0]!;
    expect(url).toBe('https://console.neon.tech/api/v2/projects/p/branches/br_9');
    expect(init.method).toBe('DELETE');
  });
});
