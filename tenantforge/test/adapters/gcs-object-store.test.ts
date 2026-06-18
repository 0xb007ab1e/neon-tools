import { describe, expect, it } from 'vitest';
import { createGcsObjectStore, type GcsClientLike } from '../../src/adapters/object-store/gcs.js';

/** A recording fake GCS client; captures each save input. */
function fakeClient(): {
  client: GcsClientLike;
  saves: { bucket: string; key: string; body: Buffer }[];
} {
  const saves: { bucket: string; key: string; body: Buffer }[] = [];
  return {
    client: {
      save: (input) => {
        saves.push(input);
        return Promise.resolve();
      },
    },
    saves,
  };
}

describe('createGcsObjectStore', () => {
  it('saves under the bare key and returns a gs:// reference + size', async () => {
    const fake = fakeClient();
    const store = createGcsObjectStore({ client: fake.client, bucket: 'exports' });
    const body = Buffer.from('dump-bytes');
    const result = await store.put('tenants/t1/2026.dump', body);

    expect(fake.saves).toEqual([{ bucket: 'exports', key: 'tenants/t1/2026.dump', body }]);
    expect(result).toEqual({
      location: 'gs://exports/tenants/t1/2026.dump',
      bytes: body.byteLength,
    });
  });

  it('prepends a trimmed prefix and strips a leading slash on the key', async () => {
    const fake = fakeClient();
    const store = createGcsObjectStore({ client: fake.client, bucket: 'b', prefix: '/tf/' });
    const result = await store.put('/tenants/t1/x.dump', Buffer.from('z'));

    expect(fake.saves[0]!.key).toBe('tf/tenants/t1/x.dump');
    expect(result.location).toBe('gs://b/tf/tenants/t1/x.dump');
  });

  it('reports the exact byte length for binary bodies', async () => {
    const fake = fakeClient();
    const store = createGcsObjectStore({ client: fake.client, bucket: 'b' });
    const result = await store.put('k', Buffer.from([0x00, 0xff, 0x10, 0x20]));
    expect(result.bytes).toBe(4);
  });
});
