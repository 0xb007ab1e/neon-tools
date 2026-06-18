import { describe, expect, it } from 'vitest';
import {
  createAwsSecretsManagerStore,
  type SecretsManagerClientLike,
} from '../../src/adapters/aws-secrets-manager/secret-store.js';

/** An AWS-SDK-shaped not-found error (`error.name === 'ResourceNotFoundException'`). */
function notFound(): Error {
  return Object.assign(new Error('resource not found'), {
    name: 'ResourceNotFoundException',
  });
}

/** Reject with an arbitrary value — exercises the adapter's handling of non-Error throws. */
function fail(value: unknown): Promise<never> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- testing non-Error rejections is the point
  return Promise.reject(value);
}

/** A recording fake Secrets Manager client; pass per-method implementations, capture inputs. */
function fakeClient(impl: Partial<SecretsManagerClientLike> = {}): {
  client: SecretsManagerClientLike;
  calls: Record<keyof SecretsManagerClientLike, unknown[]>;
} {
  const calls: Record<keyof SecretsManagerClientLike, unknown[]> = {
    getSecretValue: [],
    createSecret: [],
    putSecretValue: [],
    deleteSecret: [],
  };
  const wrap =
    <K extends keyof SecretsManagerClientLike>(key: K, fn?: SecretsManagerClientLike[K]) =>
    (input: unknown): Promise<unknown> => {
      calls[key].push(input);
      return (fn as ((i: unknown) => Promise<unknown>) | undefined)?.(input) ?? Promise.resolve({});
    };
  return {
    client: {
      getSecretValue: wrap(
        'getSecretValue',
        impl.getSecretValue,
      ) as SecretsManagerClientLike['getSecretValue'],
      createSecret: wrap('createSecret', impl.createSecret),
      putSecretValue: wrap('putSecretValue', impl.putSecretValue),
      deleteSecret: wrap('deleteSecret', impl.deleteSecret),
    },
    calls,
  };
}

describe('createAwsSecretsManagerStore — set', () => {
  it('writes a new version (PutSecretValue) under {prefix}/{key} on overwrite', async () => {
    const fake = fakeClient({ putSecretValue: () => Promise.resolve({}) });
    const store = createAwsSecretsManagerStore({ client: fake.client });
    await store.set('tenant-1', 'postgres://secret');

    expect(fake.calls.putSecretValue).toEqual([
      { SecretId: 'tenantforge/tenant-1', SecretString: 'postgres://secret' },
    ]);
    expect(fake.calls.createSecret).toHaveLength(0);
  });

  it('creates the secret on first write (PutSecretValue → ResourceNotFound → CreateSecret)', async () => {
    const fake = fakeClient({ putSecretValue: () => fail(notFound()) });
    const store = createAwsSecretsManagerStore({ client: fake.client });
    await store.set('tenant-1', 'uri');

    expect(fake.calls.putSecretValue).toHaveLength(1);
    expect(fake.calls.createSecret).toEqual([
      { Name: 'tenantforge/tenant-1', SecretString: 'uri' },
    ]);
  });

  it('propagates a non-not-found error from PutSecretValue (does not create)', async () => {
    const fake = fakeClient({ putSecretValue: () => fail(new Error('AccessDenied')) });
    const store = createAwsSecretsManagerStore({ client: fake.client });
    await expect(store.set('t', 'v')).rejects.toThrow(/AccessDenied/);
    expect(fake.calls.createSecret).toHaveLength(0);
  });
});

describe('createAwsSecretsManagerStore — get', () => {
  it('returns the stored SecretString', async () => {
    const fake = fakeClient({ getSecretValue: () => Promise.resolve({ SecretString: 'uri' }) });
    const store = createAwsSecretsManagerStore({ client: fake.client });
    expect(await store.get('t')).toBe('uri');
    expect(fake.calls.getSecretValue).toEqual([{ SecretId: 'tenantforge/t' }]);
  });

  it('returns null when the secret has no SecretString (binary-only)', async () => {
    const fake = fakeClient({ getSecretValue: () => Promise.resolve({}) });
    const store = createAwsSecretsManagerStore({ client: fake.client });
    expect(await store.get('t')).toBeNull();
  });

  it('returns null when the secret is absent (ResourceNotFound)', async () => {
    const fake = fakeClient({ getSecretValue: () => fail(notFound()) });
    const store = createAwsSecretsManagerStore({ client: fake.client });
    expect(await store.get('missing')).toBeNull();
  });

  it('propagates a different-name SDK error', async () => {
    const fake = fakeClient({ getSecretValue: () => fail(new Error('Throttling')) });
    const store = createAwsSecretsManagerStore({ client: fake.client });
    await expect(store.get('t')).rejects.toThrow(/Throttling/);
  });

  it('propagates a non-object throw (string)', async () => {
    const fake = fakeClient({ getSecretValue: () => fail('boom') });
    const store = createAwsSecretsManagerStore({ client: fake.client });
    await expect(store.get('t')).rejects.toBe('boom');
  });

  it('propagates a null throw', async () => {
    const fake = fakeClient({ getSecretValue: () => fail(null) });
    const store = createAwsSecretsManagerStore({ client: fake.client });
    await expect(store.get('t')).rejects.toBeNull();
  });

  it('propagates an object throw without a name field', async () => {
    const fake = fakeClient({ getSecretValue: () => fail({ code: 500 }) });
    const store = createAwsSecretsManagerStore({ client: fake.client });
    await expect(store.get('t')).rejects.toEqual({ code: 500 });
  });
});

describe('createAwsSecretsManagerStore — delete', () => {
  it('force-deletes without a recovery window (crypto-shred)', async () => {
    const fake = fakeClient({ deleteSecret: () => Promise.resolve({}) });
    const store = createAwsSecretsManagerStore({ client: fake.client });
    await store.delete('tenant-1');
    expect(fake.calls.deleteSecret).toEqual([
      { SecretId: 'tenantforge/tenant-1', ForceDeleteWithoutRecovery: true },
    ]);
  });

  it('is idempotent — a ResourceNotFound delete is a no-op', async () => {
    const fake = fakeClient({ deleteSecret: () => fail(notFound()) });
    const store = createAwsSecretsManagerStore({ client: fake.client });
    await expect(store.delete('gone')).resolves.toBeUndefined();
  });

  it('propagates other delete failures', async () => {
    const fake = fakeClient({ deleteSecret: () => fail(new Error('InternalServiceError')) });
    const store = createAwsSecretsManagerStore({ client: fake.client });
    await expect(store.delete('t')).rejects.toThrow(/InternalServiceError/);
  });
});

describe('createAwsSecretsManagerStore — config', () => {
  it('honors a custom prefix and trims surrounding slashes', async () => {
    const fake = fakeClient({ getSecretValue: () => Promise.resolve({ SecretString: 'x' }) });
    const store = createAwsSecretsManagerStore({ client: fake.client, prefix: '/tf/conn/' });
    await store.get('a');
    expect(fake.calls.getSecretValue).toEqual([{ SecretId: 'tf/conn/a' }]);
  });
});
