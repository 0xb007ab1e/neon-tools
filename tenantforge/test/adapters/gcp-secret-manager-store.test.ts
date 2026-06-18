import { describe, expect, it } from 'vitest';
import {
  createGcpSecretManagerStore,
  type GcpSecretManagerClientLike,
} from '../../src/adapters/gcp-secret-manager/secret-store.js';

/** A gRPC-shaped error carrying a numeric status `code`. */
function grpcError(code: number, message = 'grpc'): Error {
  return Object.assign(new Error(message), { code });
}

/** Reject with an arbitrary value — exercises propagation of unhandled errors. */
function fail(value: unknown): Promise<never> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- testing non-Error/odd rejections
  return Promise.reject(value);
}

type Calls = Record<keyof GcpSecretManagerClientLike, unknown[]>;

/** A recording fake Secret Manager client; pass per-method implementations, capture inputs. */
function fakeClient(impl: Partial<GcpSecretManagerClientLike> = {}): {
  client: GcpSecretManagerClientLike;
  calls: Calls;
} {
  const calls: Calls = {
    createSecret: [],
    addSecretVersion: [],
    accessSecretVersion: [],
    deleteSecret: [],
  };
  const wrap =
    <K extends keyof GcpSecretManagerClientLike>(key: K, fn?: GcpSecretManagerClientLike[K]) =>
    (input: unknown): Promise<unknown> => {
      calls[key].push(input);
      return (fn as ((i: unknown) => Promise<unknown>) | undefined)?.(input) ?? Promise.resolve({});
    };
  return {
    client: {
      createSecret: wrap('createSecret', impl.createSecret),
      addSecretVersion: wrap('addSecretVersion', impl.addSecretVersion),
      accessSecretVersion: wrap(
        'accessSecretVersion',
        impl.accessSecretVersion,
      ) as GcpSecretManagerClientLike['accessSecretVersion'],
      deleteSecret: wrap('deleteSecret', impl.deleteSecret),
    },
    calls,
  };
}

const base = { project: 'proj-1' };

describe('createGcpSecretManagerStore — set', () => {
  it('creates the secret then adds a version (first write)', async () => {
    const fake = fakeClient();
    const store = createGcpSecretManagerStore({ ...base, client: fake.client });
    await store.set('t1', 'postgres://secret');

    expect(fake.calls.createSecret).toEqual([
      { parent: 'projects/proj-1', secretId: 'tenantforge-t1' },
    ]);
    expect(fake.calls.addSecretVersion).toHaveLength(1);
    const addInput = fake.calls.addSecretVersion[0] as {
      parent: string;
      payload: { data: Buffer };
    };
    expect(addInput.parent).toBe('projects/proj-1/secrets/tenantforge-t1');
    expect(addInput.payload.data.toString('utf8')).toBe('postgres://secret');
  });

  it('tolerates ALREADY_EXISTS on create and still adds a version (overwrite)', async () => {
    const fake = fakeClient({ createSecret: () => fail(grpcError(6, 'already exists')) });
    const store = createGcpSecretManagerStore({ ...base, client: fake.client });
    await store.set('t1', 'v2');
    expect(fake.calls.addSecretVersion).toHaveLength(1);
  });

  it('propagates a non-already-exists create error (no version added)', async () => {
    const fake = fakeClient({ createSecret: () => fail(grpcError(7, 'permission denied')) });
    const store = createGcpSecretManagerStore({ ...base, client: fake.client });
    await expect(store.set('t1', 'v')).rejects.toThrow(/permission denied/);
    expect(fake.calls.addSecretVersion).toHaveLength(0);
  });
});

describe('createGcpSecretManagerStore — get', () => {
  it('accesses the latest version and decodes a Buffer payload to utf8', async () => {
    const fake = fakeClient({
      accessSecretVersion: () => Promise.resolve({ payload: { data: Buffer.from('uri', 'utf8') } }),
    });
    const store = createGcpSecretManagerStore({ ...base, client: fake.client });
    expect(await store.get('t1')).toBe('uri');
    expect(fake.calls.accessSecretVersion).toEqual([
      { name: 'projects/proj-1/secrets/tenantforge-t1/versions/latest' },
    ]);
  });

  it('passes a string payload through unchanged (REST-shim shape)', async () => {
    const fake = fakeClient({
      accessSecretVersion: () => Promise.resolve({ payload: { data: 'already-a-string' } }),
    });
    const store = createGcpSecretManagerStore({ ...base, client: fake.client });
    expect(await store.get('t1')).toBe('already-a-string');
  });

  it('returns null when the payload data is null', async () => {
    const fake = fakeClient({
      accessSecretVersion: () => Promise.resolve({ payload: { data: null } }),
    });
    const store = createGcpSecretManagerStore({ ...base, client: fake.client });
    expect(await store.get('t1')).toBeNull();
  });

  it('returns null when there is no payload', async () => {
    const fake = fakeClient({ accessSecretVersion: () => Promise.resolve({}) });
    const store = createGcpSecretManagerStore({ ...base, client: fake.client });
    expect(await store.get('t1')).toBeNull();
  });

  it('returns null when the secret is absent (NOT_FOUND)', async () => {
    const fake = fakeClient({ accessSecretVersion: () => fail(grpcError(5, 'not found')) });
    const store = createGcpSecretManagerStore({ ...base, client: fake.client });
    expect(await store.get('missing')).toBeNull();
  });

  it('propagates a non-not-found access error', async () => {
    const fake = fakeClient({ accessSecretVersion: () => fail(grpcError(13, 'internal')) });
    const store = createGcpSecretManagerStore({ ...base, client: fake.client });
    await expect(store.get('t1')).rejects.toThrow(/internal/);
  });

  it('propagates a non-object throw (no code field at all)', async () => {
    const fake = fakeClient({ accessSecretVersion: () => fail('boom') });
    const store = createGcpSecretManagerStore({ ...base, client: fake.client });
    await expect(store.get('t1')).rejects.toBe('boom');
  });
});

describe('createGcpSecretManagerStore — delete', () => {
  it('deletes the secret (all versions) by name', async () => {
    const fake = fakeClient();
    const store = createGcpSecretManagerStore({ ...base, client: fake.client });
    await store.delete('t1');
    expect(fake.calls.deleteSecret).toEqual([{ name: 'projects/proj-1/secrets/tenantforge-t1' }]);
  });

  it('is idempotent — NOT_FOUND is a no-op', async () => {
    const fake = fakeClient({ deleteSecret: () => fail(grpcError(5)) });
    const store = createGcpSecretManagerStore({ ...base, client: fake.client });
    await expect(store.delete('gone')).resolves.toBeUndefined();
  });

  it('propagates other delete failures', async () => {
    const fake = fakeClient({ deleteSecret: () => fail(grpcError(13, 'internal')) });
    const store = createGcpSecretManagerStore({ ...base, client: fake.client });
    await expect(store.delete('t1')).rejects.toThrow(/internal/);
  });
});

describe('createGcpSecretManagerStore — config', () => {
  it('uses the bare key when the prefix is empty', async () => {
    const fake = fakeClient();
    const store = createGcpSecretManagerStore({ ...base, client: fake.client, prefix: '' });
    await store.delete('t1');
    expect(fake.calls.deleteSecret).toEqual([{ name: 'projects/proj-1/secrets/t1' }]);
  });

  it('trims stray dashes from a custom prefix', async () => {
    const fake = fakeClient();
    const store = createGcpSecretManagerStore({ ...base, client: fake.client, prefix: '-tf-' });
    await store.delete('t1');
    expect(fake.calls.deleteSecret).toEqual([{ name: 'projects/proj-1/secrets/tf-t1' }]);
  });
});
