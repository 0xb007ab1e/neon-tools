import { describe, expect, it } from 'vitest';
import { createS3ObjectStore, type S3ClientLike } from '../../src/adapters/object-store/s3.js';

/** A recording fake S3 client; captures each PutObject input. */
function fakeClient(): {
  client: S3ClientLike;
  puts: { Bucket: string; Key: string; Body: Uint8Array }[];
} {
  const puts: { Bucket: string; Key: string; Body: Uint8Array }[] = [];
  return {
    client: {
      putObject: (input) => {
        puts.push(input);
        return Promise.resolve({});
      },
    },
    puts,
  };
}

describe('createS3ObjectStore', () => {
  it('puts under the bare key and returns an s3:// reference + size', async () => {
    const fake = fakeClient();
    const store = createS3ObjectStore({ client: fake.client, bucket: 'exports' });
    const body = Buffer.from('dump-bytes');
    const result = await store.put('tenants/t1/2026.dump', body);

    expect(fake.puts).toHaveLength(1);
    expect(fake.puts[0]!.Bucket).toBe('exports');
    expect(fake.puts[0]!.Key).toBe('tenants/t1/2026.dump');
    expect(fake.puts[0]!.Body).toBe(body);
    expect(result).toEqual({
      location: 's3://exports/tenants/t1/2026.dump',
      bytes: body.byteLength,
    });
  });

  it('prepends a trimmed prefix and strips a leading slash on the key', async () => {
    const fake = fakeClient();
    const store = createS3ObjectStore({ client: fake.client, bucket: 'b', prefix: '/tf/' });
    const result = await store.put('/tenants/t1/x.dump', Buffer.from('z'));

    expect(fake.puts[0]!.Key).toBe('tf/tenants/t1/x.dump');
    expect(result.location).toBe('s3://b/tf/tenants/t1/x.dump');
  });

  it('reports the exact byte length for binary bodies', async () => {
    const fake = fakeClient();
    const store = createS3ObjectStore({ client: fake.client, bucket: 'b' });
    const body = Buffer.from([0x00, 0xff, 0x10, 0x20]);
    const result = await store.put('k', body);
    expect(result.bytes).toBe(4);
  });
});
