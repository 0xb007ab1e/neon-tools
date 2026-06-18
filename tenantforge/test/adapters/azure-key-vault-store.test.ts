import { describe, expect, it, vi } from 'vitest';
import { createAzureKeyVaultStore } from '../../src/adapters/azure-key-vault/secret-store.js';

interface Call {
  url: string;
  method: string;
  init: RequestInit;
}

/** A recording fake fetch that serves responses (by call) and captures each request. */
function recorder(responder: (call: Call) => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    const href = url instanceof Request ? url.url : url.toString();
    const call = { url: href, method: init?.method ?? 'GET', init: init ?? {} };
    calls.push(call);
    return Promise.resolve(responder(call));
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const base = {
  vaultUrl: 'https://v.vault.azure.net/',
  getToken: (): Promise<string> => Promise.resolve('tok-123'),
};

describe('createAzureKeyVaultStore — set', () => {
  it('PUTs the value to the secret path with a bearer token + api-version', async () => {
    const rec = recorder(() => new Response('{}', { status: 200 }));
    const store = createAzureKeyVaultStore({ ...base, fetchImpl: rec.fetch });
    await store.set('t1', 'postgres://secret');

    const call = rec.calls[0]!;
    // Trailing slash on vaultUrl trimmed; default prefix `tenantforge`, default api-version 7.4.
    expect(call.url).toBe('https://v.vault.azure.net/secrets/tenantforge-t1?api-version=7.4');
    expect(call.method).toBe('PUT');
    expect(JSON.parse(call.init.body as string)).toEqual({ value: 'postgres://secret' });
    expect((call.init.headers as Record<string, string>).authorization).toBe('Bearer tok-123');
  });

  it('throws with status + detail on a non-2xx write', async () => {
    const rec = recorder(() => new Response('forbidden', { status: 403 }));
    const store = createAzureKeyVaultStore({ ...base, fetchImpl: rec.fetch });
    await expect(store.set('t', 'v')).rejects.toThrow(/Key Vault write failed: HTTP 403 forbidden/);
  });
});

describe('createAzureKeyVaultStore — get', () => {
  it('returns the stored value', async () => {
    const rec = recorder(() => new Response(JSON.stringify({ value: 'uri' }), { status: 200 }));
    const store = createAzureKeyVaultStore({ ...base, fetchImpl: rec.fetch });
    expect(await store.get('t')).toBe('uri');
    expect(rec.calls[0]!.method).toBe('GET');
  });

  it('returns null when absent (404)', async () => {
    const rec = recorder(() => new Response('', { status: 404 }));
    const store = createAzureKeyVaultStore({ ...base, fetchImpl: rec.fetch });
    expect(await store.get('missing')).toBeNull();
  });

  it('throws on a non-2xx, non-404 read', async () => {
    const rec = recorder(() => new Response('boom', { status: 500 }));
    const store = createAzureKeyVaultStore({ ...base, fetchImpl: rec.fetch });
    await expect(store.get('t')).rejects.toThrow(/Key Vault read failed: HTTP 500 boom/);
  });
});

/** Respond differently to the soft-delete (`/secrets/`) and the purge (`/deletedsecrets/`) calls. */
function deleteRecorder(secretStatus: number, deletedStatus: number): ReturnType<typeof recorder> {
  return recorder((call) =>
    call.url.includes('/deletedsecrets/')
      ? new Response('', { status: deletedStatus })
      : new Response('', { status: secretStatus }),
  );
}

describe('createAzureKeyVaultStore — delete', () => {
  it('soft-deletes then purges (true crypto-shred), hitting both endpoints', async () => {
    const rec = deleteRecorder(200, 200);
    const store = createAzureKeyVaultStore({ ...base, fetchImpl: rec.fetch });
    await store.delete('t1');

    expect(rec.calls).toHaveLength(2);
    expect(rec.calls[0]!.url).toBe(
      'https://v.vault.azure.net/secrets/tenantforge-t1?api-version=7.4',
    );
    expect(rec.calls[0]!.method).toBe('DELETE');
    expect(rec.calls[1]!.url).toBe(
      'https://v.vault.azure.net/deletedsecrets/tenantforge-t1?api-version=7.4',
    );
  });

  it('tolerates a 404 soft-delete (already gone) and still attempts purge', async () => {
    const rec = deleteRecorder(404, 200);
    const store = createAzureKeyVaultStore({ ...base, fetchImpl: rec.fetch });
    await expect(store.delete('gone')).resolves.toBeUndefined();
    expect(rec.calls).toHaveLength(2);
  });

  it('throws on a non-404 soft-delete failure (no purge attempted)', async () => {
    const rec = deleteRecorder(500, 200);
    const store = createAzureKeyVaultStore({ ...base, fetchImpl: rec.fetch });
    await expect(store.delete('t')).rejects.toThrow(/Key Vault delete failed: HTTP 500/);
    expect(rec.calls).toHaveLength(1);
  });

  it.each([403, 404, 409])('tolerates a %d on purge (policy / race)', async (status) => {
    const rec = deleteRecorder(200, status);
    const store = createAzureKeyVaultStore({ ...base, fetchImpl: rec.fetch });
    await expect(store.delete('t')).resolves.toBeUndefined();
  });

  it('throws on an unexpected purge failure', async () => {
    const rec = deleteRecorder(200, 500);
    const store = createAzureKeyVaultStore({ ...base, fetchImpl: rec.fetch });
    await expect(store.delete('t')).rejects.toThrow(/Key Vault purge failed: HTTP 500/);
  });
});

describe('createAzureKeyVaultStore — config', () => {
  it('honors a custom prefix / api-version and encodes the name segment', async () => {
    const rec = recorder(() => new Response(JSON.stringify({ value: 'x' }), { status: 200 }));
    const store = createAzureKeyVaultStore({
      ...base,
      prefix: '-tf-',
      apiVersion: '7.5',
      fetchImpl: rec.fetch,
    });
    await store.get('a b');
    expect(rec.calls[0]!.url).toBe('https://v.vault.azure.net/secrets/tf-a%20b?api-version=7.5');
  });

  it('uses the bare key when the prefix is empty', async () => {
    const rec = recorder(() => new Response(JSON.stringify({ value: 'x' }), { status: 200 }));
    const store = createAzureKeyVaultStore({ ...base, prefix: '', fetchImpl: rec.fetch });
    await store.get('t1');
    expect(rec.calls[0]!.url).toBe('https://v.vault.azure.net/secrets/t1?api-version=7.4');
  });

  it('tolerates a body that cannot be read (detail falls back to empty)', async () => {
    const bad = {
      ok: false,
      status: 500,
      text: () => Promise.reject(new Error('stream error')),
    } as unknown as Response;
    const store = createAzureKeyVaultStore({ ...base, fetchImpl: () => Promise.resolve(bad) });
    await expect(store.set('t', 'v')).rejects.toThrow(/Key Vault write failed: HTTP 500 *$/);
  });

  it('falls back to the global fetch when none is injected', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    try {
      const store = createAzureKeyVaultStore({ vaultUrl: base.vaultUrl, getToken: base.getToken });
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
    const store = createAzureKeyVaultStore({ ...base, timeoutMs: 5, fetchImpl: hang });
    await expect(store.get('t')).rejects.toThrow(/aborted/);
  });
});
