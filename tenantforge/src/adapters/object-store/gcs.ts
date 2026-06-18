import type { ObjectStore, PutResult } from '../../ports/object-store.js';

// --- A minimal GCS client surface (the one call this adapter uses) -----------------------------
// Zero-dependency by design: the `@google-cloud/storage` `Storage` client satisfies this via a tiny
// shim, so we don't pull the SDK tree into the project. Wire it at the composition root, e.g.:
//   const storage = new Storage();
//   const client: GcsClientLike = {
//     save: ({ bucket, key, body }) => storage.bucket(bucket).file(key).save(body),
//   };

/** The narrow GCS client this adapter depends on (the `@google-cloud/storage` client satisfies it). */
export interface GcsClientLike {
  /** Write an object's bytes to `key` in `bucket` (the SDK's `bucket(b).file(k).save(body)`). */
  save(input: { bucket: string; key: string; body: Buffer }): Promise<void>;
}

/** Options for {@link createGcsObjectStore}. */
export interface GcsObjectStoreOptions {
  /** The narrow GCS client (wrap your `@google-cloud/storage` `Storage` client). */
  client: GcsClientLike;
  /** Destination bucket. */
  bucket: string;
  /** Optional key prefix to namespace objects within the bucket (e.g. `tenantforge`). */
  prefix?: string;
}

/**
 * Create an {@link ObjectStore} backed by **Google Cloud Storage**, over a minimal injected client
 * (so the Google SDK is not a dependency of this project — wrap your `Storage` client per the shim
 * above). The off-Neon sink for export artifacts (`pg_dump`), alongside the filesystem and S3 stores;
 * the same injected-client shape.
 *
 * `put` writes the bytes under `{prefix}/{key}` (leading slashes trimmed) and returns a
 * `gs://{bucket}/{key}` reference plus the byte size. Object keys are flat (no path-traversal
 * surface, unlike a filesystem root).
 *
 * @param options - The GCS client, destination bucket, and optional key prefix.
 * @returns A GCS-backed object store.
 */
export function createGcsObjectStore(options: GcsObjectStoreOptions): ObjectStore {
  const { client, bucket } = options;
  const prefix = (options.prefix ?? '').replace(/^\/+|\/+$/g, '');

  return {
    async put(key: string, body: Buffer): Promise<PutResult> {
      const cleanKey = key.replace(/^\/+/, '');
      const objectKey = prefix === '' ? cleanKey : `${prefix}/${cleanKey}`;
      await client.save({ bucket, key: objectKey, body });
      return { location: `gs://${bucket}/${objectKey}`, bytes: body.byteLength };
    },
  };
}
