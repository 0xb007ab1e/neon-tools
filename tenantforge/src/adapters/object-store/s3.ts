import type { ObjectStore, PutResult } from '../../ports/object-store.js';

// --- A minimal S3 client surface (the one call this adapter uses) ------------------------------
// Zero-dependency by design: the AWS SDK v3 `S3Client` satisfies this via a tiny shim, so we don't
// pull the SDK tree into the project. Wire it at the composition root, e.g.:
//   const s3 = new S3Client({ region });
//   const client: S3ClientLike = { putObject: (i) => s3.send(new PutObjectCommand(i)) };
// Cloudflare R2 / MinIO / any S3-compatible store: construct the `S3Client` with that `endpoint`
// (and `forcePathStyle` where required) — this adapter is unchanged.

/** The narrow S3 client this adapter depends on (the AWS SDK `S3Client` satisfies it via a shim). */
export interface S3ClientLike {
  /** `PutObject` — write an object's bytes under a key in a bucket. */
  putObject(input: { Bucket: string; Key: string; Body: Uint8Array }): Promise<unknown>;
}

/** Options for {@link createS3ObjectStore}. */
export interface S3ObjectStoreOptions {
  /** The narrow S3 client (wrap your `@aws-sdk/client-s3` `S3Client`, or an R2-pointed one). */
  client: S3ClientLike;
  /** Destination bucket. */
  bucket: string;
  /** Optional key prefix to namespace objects within the bucket (e.g. `tenantforge`). */
  prefix?: string;
}

/**
 * Create an {@link ObjectStore} backed by **AWS S3** (or any S3-compatible store — Cloudflare R2,
 * MinIO, GCS's S3 endpoint), over a minimal injected client (so the AWS SDK is not a dependency of
 * this project — wrap your `S3Client` per the shim above). The off-Neon sink for export artifacts
 * (`pg_dump`), alongside the filesystem store; the same injected-client shape as the SQS queue.
 *
 * `put` writes the bytes with `PutObject` under `{prefix}/{key}` (leading slashes trimmed) and returns
 * an `s3://{bucket}/{key}` reference plus the byte size. Object keys are flat (no path-traversal
 * surface, unlike a filesystem root). For R2 / S3-compatible stores, point the `S3Client` at the
 * custom endpoint at the composition root — this adapter needs no change.
 *
 * @param options - The S3 client, destination bucket, and optional key prefix.
 * @returns An S3-backed object store.
 */
export function createS3ObjectStore(options: S3ObjectStoreOptions): ObjectStore {
  const { client, bucket } = options;
  const prefix = (options.prefix ?? '').replace(/^\/+|\/+$/g, '');

  return {
    async put(key: string, body: Buffer): Promise<PutResult> {
      const cleanKey = key.replace(/^\/+/, '');
      const Key = prefix === '' ? cleanKey : `${prefix}/${cleanKey}`;
      await client.putObject({ Bucket: bucket, Key, Body: body });
      return { location: `s3://${bucket}/${Key}`, bytes: body.byteLength };
    },
  };
}
