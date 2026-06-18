import { describe, expect, it } from 'vitest';
import {
  createAzureBlobObjectStore,
  type AzureBlobClientLike,
} from '../../src/adapters/object-store/azure-blob.js';

/** A recording fake Azure Blob client; captures each upload input. */
function fakeClient(): {
  client: AzureBlobClientLike;
  uploads: { container: string; blob: string; body: Buffer }[];
} {
  const uploads: { container: string; blob: string; body: Buffer }[] = [];
  return {
    client: {
      upload: (input) => {
        uploads.push(input);
        return Promise.resolve();
      },
    },
    uploads,
  };
}

describe('createAzureBlobObjectStore', () => {
  it('uploads under the bare key and returns an azure-blob:// reference + size', async () => {
    const fake = fakeClient();
    const store = createAzureBlobObjectStore({ client: fake.client, container: 'exports' });
    const body = Buffer.from('dump-bytes');
    const result = await store.put('tenants/t1/2026.dump', body);

    expect(fake.uploads).toEqual([{ container: 'exports', blob: 'tenants/t1/2026.dump', body }]);
    expect(result).toEqual({
      location: 'azure-blob://exports/tenants/t1/2026.dump',
      bytes: body.byteLength,
    });
  });

  it('prepends a trimmed prefix and strips a leading slash on the key', async () => {
    const fake = fakeClient();
    const store = createAzureBlobObjectStore({
      client: fake.client,
      container: 'c',
      prefix: '/tf/',
    });
    const result = await store.put('/tenants/t1/x.dump', Buffer.from('z'));

    expect(fake.uploads[0]!.blob).toBe('tf/tenants/t1/x.dump');
    expect(result.location).toBe('azure-blob://c/tf/tenants/t1/x.dump');
  });

  it('returns a resolvable https location when an account URL is given (trailing slash trimmed)', async () => {
    const fake = fakeClient();
    const store = createAzureBlobObjectStore({
      client: fake.client,
      container: 'c',
      accountUrl: 'https://acct.blob.core.windows.net/',
    });
    const result = await store.put('k.dump', Buffer.from('x'));
    expect(result.location).toBe('https://acct.blob.core.windows.net/c/k.dump');
  });

  it('reports the exact byte length for binary bodies', async () => {
    const fake = fakeClient();
    const store = createAzureBlobObjectStore({ client: fake.client, container: 'c' });
    const result = await store.put('k', Buffer.from([0x00, 0xff, 0x10, 0x20]));
    expect(result.bytes).toBe(4);
  });
});
