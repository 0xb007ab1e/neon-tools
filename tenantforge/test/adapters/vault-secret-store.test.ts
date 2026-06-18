import { describe, expect, it, vi } from 'vitest';
import { createVaultSecretStore } from '../../src/adapters/vault/secret-store.js';

interface Call {
  url: string;
  init: RequestInit;
}

/** A recording fake fetch that serves a queue (or fixed) of responses and captures each call. */
function recorder(responder: (call: Call) => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    const href = url instanceof Request ? url.url : url.toString();
    const call = { url: href, init: init ?? {} };
    calls.push(call);
    return Promise.resolve(responder(call));
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const base = {
  address: 'https://vault.example.com:8200/',
  token: 'tok-123',
  fetchImpl: undefined as unknown as typeof fetch,
};

describe('createVaultSecretStore — set', () => {
  it('POSTs to the KV v2 data path with the value wrapped + auth header', async () => {
    const rec = recorder(() => new Response('{}', { status: 200 }));
    const store = createVaultSecretStore({ ...base, fetchImpl: rec.fetch });
    await store.set('tenant-1', 'postgres://secret');

    expect(rec.calls).toHaveLength(1);
    const { url, init } = rec.calls[0]!;
    // Trailing slash on address trimmed; default mount `secret`, default prefix `tenantforge`.
    expect(url).toBe('https://vault.example.com:8200/v1/secret/data/tenantforge/tenant-1');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ data: { value: 'postgres://secret' } });
    expect((init.headers as Record<string, string>)['x-vault-token']).toBe('tok-123');
  });

  it('throws with status + detail on a non-2xx write', async () => {
    const rec = recorder(() => new Response('permission denied', { status: 403 }));
    const store = createVaultSecretStore({ ...base, fetchImpl: rec.fetch });
    await expect(store.set('t', 'v')).rejects.toThrow(
      /Vault write failed: HTTP 403 permission denied/,
    );
  });

  it('tolerates a body that cannot be read (detail falls back to empty)', async () => {
    const bad = {
      ok: false,
      status: 500,
      text: () => Promise.reject(new Error('stream error')),
    } as unknown as Response;
    const store = createVaultSecretStore({ ...base, fetchImpl: () => Promise.resolve(bad) });
    await expect(store.set('t', 'v')).rejects.toThrow(/Vault write failed: HTTP 500 *$/);
  });
});

describe('createVaultSecretStore — get', () => {
  it('returns the stored value', async () => {
    const rec = recorder(
      () => new Response(JSON.stringify({ data: { data: { value: 'uri' } } }), { status: 200 }),
    );
    const store = createVaultSecretStore({ ...base, fetchImpl: rec.fetch });
    expect(await store.get('t')).toBe('uri');
    expect(rec.calls[0]!.init.method).toBe('GET');
  });

  it('returns null when the key is absent (404)', async () => {
    const rec = recorder(() => new Response('', { status: 404 }));
    const store = createVaultSecretStore({ ...base, fetchImpl: rec.fetch });
    expect(await store.get('missing')).toBeNull();
  });

  it('returns null for a soft-deleted version (data.data === null)', async () => {
    const rec = recorder(
      () => new Response(JSON.stringify({ data: { data: null } }), { status: 200 }),
    );
    const store = createVaultSecretStore({ ...base, fetchImpl: rec.fetch });
    expect(await store.get('t')).toBeNull();
  });

  it('returns null when the whole data envelope is null', async () => {
    const rec = recorder(() => new Response(JSON.stringify({ data: null }), { status: 200 }));
    const store = createVaultSecretStore({ ...base, fetchImpl: rec.fetch });
    expect(await store.get('t')).toBeNull();
  });

  it('throws on a non-2xx, non-404 read', async () => {
    const rec = recorder(() => new Response('sealed', { status: 503 }));
    const store = createVaultSecretStore({ ...base, fetchImpl: rec.fetch });
    await expect(store.get('t')).rejects.toThrow(/Vault read failed: HTTP 503 sealed/);
  });
});

describe('createVaultSecretStore — delete', () => {
  it('DELETEs the metadata path (full crypto-shred)', async () => {
    const rec = recorder(() => new Response(null, { status: 204 }));
    const store = createVaultSecretStore({ ...base, fetchImpl: rec.fetch });
    await store.delete('tenant-1');
    expect(rec.calls[0]!.url).toBe(
      'https://vault.example.com:8200/v1/secret/metadata/tenantforge/tenant-1',
    );
    expect(rec.calls[0]!.init.method).toBe('DELETE');
  });

  it('is idempotent — a 404 is treated as already gone', async () => {
    const rec = recorder(() => new Response('', { status: 404 }));
    const store = createVaultSecretStore({ ...base, fetchImpl: rec.fetch });
    await expect(store.delete('gone')).resolves.toBeUndefined();
  });

  it('throws on other delete failures', async () => {
    const rec = recorder(() => new Response('boom', { status: 500 }));
    const store = createVaultSecretStore({ ...base, fetchImpl: rec.fetch });
    await expect(store.delete('t')).rejects.toThrow(/Vault delete failed: HTTP 500 boom/);
  });
});

describe('createVaultSecretStore — config', () => {
  it('honors custom mount/prefix/namespace and encodes the key segment', async () => {
    const rec = recorder(() => new Response('{}', { status: 200 }));
    const store = createVaultSecretStore({
      ...base,
      mountPath: '/kv/',
      pathPrefix: '/tf/conn/',
      namespace: 'team-a',
      fetchImpl: rec.fetch,
    });
    await store.set('a/b', 'v');
    expect(rec.calls[0]!.url).toBe('https://vault.example.com:8200/v1/kv/data/tf/conn/a%2Fb');
    expect((rec.calls[0]!.init.headers as Record<string, string>)['x-vault-namespace']).toBe(
      'team-a',
    );
  });

  it('omits the namespace header when it is empty', async () => {
    const rec = recorder(() => new Response('{}', { status: 200 }));
    const store = createVaultSecretStore({ ...base, namespace: '', fetchImpl: rec.fetch });
    await store.set('t', 'v');
    expect(
      (rec.calls[0]!.init.headers as Record<string, string>)['x-vault-namespace'],
    ).toBeUndefined();
  });

  it('falls back to the global fetch when none is injected', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    try {
      const store = createVaultSecretStore({ address: base.address, token: base.token });
      await store.set('t', 'v');
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });

  it('aborts the request when the timeout elapses', async () => {
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch;
    const store = createVaultSecretStore({ ...base, timeoutMs: 5, fetchImpl: hang });
    await expect(store.get('t')).rejects.toThrow(/aborted/);
  });
});
