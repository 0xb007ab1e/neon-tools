import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ObjectStore, PutResult } from '../../ports/object-store.js';

/** Options for {@link createFilesystemObjectStore}. */
export interface FilesystemObjectStoreOptions {
  /** Root directory for artifacts (e.g. a mounted EFS/NFS volume). Must be absolute. */
  dir: string;
}

/**
 * Create an {@link ObjectStore} that writes objects to a local/mounted filesystem directory.
 *
 * The dependency-free, Neon-adjacent sink for export artifacts: point `dir` at a durable mounted
 * volume. Keys are **confined to the root** (path-traversal rejected — `std-cwe` CWE-22); parent
 * directories are created as needed. S3 / GCS / R2 adapters can follow behind the same port.
 *
 * @param options - The artifact root directory (absolute).
 * @returns A filesystem-backed object store.
 */
export function createFilesystemObjectStore(options: FilesystemObjectStoreOptions): ObjectStore {
  if (!isAbsolute(options.dir)) {
    throw new Error('FilesystemObjectStore: dir must be an absolute path');
  }
  const root = resolve(options.dir);

  return {
    async put(key: string, body: Buffer): Promise<PutResult> {
      // Confine the resolved target to the root — reject `..` traversal and absolute-key escapes.
      const target = resolve(join(root, normalize(key)));
      if (target !== root && !target.startsWith(root + sep)) {
        throw new Error(`FilesystemObjectStore: key escapes the root directory: ${key}`);
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, body, { flag: 'w' });
      return { location: pathToFileURL(target).href, bytes: body.byteLength };
    },
  };
}
