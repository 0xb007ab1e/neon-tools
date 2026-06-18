import type { ObjectStore, PutResult } from '../../ports/object-store.js';

// --- A minimal Azure Blob client surface (the one call this adapter uses) ----------------------
// Zero-dependency by design: the `@azure/storage-blob` `BlobServiceClient` satisfies this via a tiny
// shim, so we don't pull the SDK tree into the project. Wire it at the composition root, e.g.:
//   const svc = BlobServiceClient.fromConnectionString(conn); // or new BlobServiceClient(url, cred)
//   const client: AzureBlobClientLike = {
//     upload: ({ container, blob, body }) =>
//       svc.getContainerClient(container).getBlockBlobClient(blob).uploadData(body).then(() => {}),
//   };

/** The narrow Azure Blob client this adapter depends on (the `@azure/storage-blob` SDK satisfies it). */
export interface AzureBlobClientLike {
  /** Upload an object's bytes to `blob` in `container` (the SDK's block-blob `uploadData`). */
  upload(input: { container: string; blob: string; body: Buffer }): Promise<void>;
}

/** Options for {@link createAzureBlobObjectStore}. */
export interface AzureBlobObjectStoreOptions {
  /** The narrow Blob client (wrap your `@azure/storage-blob` `BlobServiceClient`). */
  client: AzureBlobClientLike;
  /** Destination container. */
  container: string;
  /** Optional blob-name prefix to namespace objects within the container (e.g. `tenantforge`). */
  prefix?: string;
  /**
   * Storage-account base URL (e.g. `https://acct.blob.core.windows.net`). When set, `put` returns a
   * resolvable `https://…/{container}/{blob}` location; otherwise an `azure-blob://{container}/{blob}`
   * reference (the account lives inside the injected client).
   */
  accountUrl?: string;
}

/**
 * Create an {@link ObjectStore} backed by **Azure Blob Storage**, over a minimal injected client (so
 * the Azure SDK is not a dependency of this project — wrap your `BlobServiceClient` per the shim
 * above). The off-Neon sink for export artifacts (`pg_dump`), alongside the filesystem, S3, and GCS
 * stores; the same injected-client shape.
 *
 * `put` uploads the bytes to `{prefix}/{key}` (leading slashes trimmed) in the container and returns
 * a location reference plus the byte size — a resolvable `https://…/{container}/{blob}` when
 * `accountUrl` is set, else `azure-blob://{container}/{blob}`. Blob names are flat (no path-traversal
 * surface, unlike a filesystem root).
 *
 * @param options - The Blob client, container, optional key prefix, and optional account URL.
 * @returns An Azure Blob-backed object store.
 */
export function createAzureBlobObjectStore(options: AzureBlobObjectStoreOptions): ObjectStore {
  const { client, container } = options;
  const prefix = (options.prefix ?? '').replace(/^\/+|\/+$/g, '');

  return {
    async put(key: string, body: Buffer): Promise<PutResult> {
      const cleanKey = key.replace(/^\/+/, '');
      const blob = prefix === '' ? cleanKey : `${prefix}/${cleanKey}`;
      await client.upload({ container, blob, body });
      const location =
        options.accountUrl === undefined
          ? `azure-blob://${container}/${blob}`
          : `${options.accountUrl.replace(/\/+$/, '')}/${container}/${blob}`;
      return { location, bytes: body.byteLength };
    },
  };
}
