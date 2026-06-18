/** The outcome of writing an object: a durable reference + its size. */
export interface PutResult {
  /** A reference to the written object (e.g. `file:///…`, `s3://bucket/key`). */
  location: string;
  /** Size of the stored object in bytes. */
  bytes: number;
}

/**
 * Port: a durable blob/object store for export artifacts (a tenant `pg_dump`).
 *
 * The Neon-prioritized exporter retains the project (no data movement); this seam is for the
 * off-Neon path — write the dump to durable storage. A filesystem adapter ships now; S3 / GCS / R2
 * adapters can follow behind this port in their own branches.
 */
export interface ObjectStore {
  /**
   * Store an object under a key and return a durable reference.
   *
   * @param key - The object key (path-like, e.g. `tenant/{id}/{ts}.dump`).
   * @param body - The object bytes.
   * @returns The location reference + byte size.
   */
  put(key: string, body: Buffer): Promise<PutResult>;
}
