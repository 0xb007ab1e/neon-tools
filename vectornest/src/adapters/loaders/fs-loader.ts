import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import type { SourceDocument } from '../../core/domain.js';
import type { DocumentLoader } from '../../ports/document-loader.js';

/** Default text file extensions the loader ingests. */
const DEFAULT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.text']);

/** Configuration for the filesystem document loader. */
export interface FsLoaderOptions {
  /** Lowercased extensions (with dot) to include. Defaults to common text/markdown. */
  extensions?: Set<string>;
  /** Skip files larger than this many bytes (DoS guard). Defaults to 5 MB. */
  maxBytes?: number;
}

/**
 * Recursively yield file paths under a directory.
 *
 * @param dir - Directory to walk.
 * @returns An async iterable of absolute file paths.
 */
async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/**
 * Create a {@link DocumentLoader} that reads text files from a directory (or a single file).
 *
 * Each document's content hash (SHA-256 of the raw bytes) is computed here and drives ingest
 * idempotency downstream. Oversized files are skipped to bound memory/cost.
 *
 * @param options - Extension allow-list and size cap.
 * @returns A filesystem-backed document loader.
 */
export function createFsLoader(options: FsLoaderOptions = {}): DocumentLoader {
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
  const maxBytes = options.maxBytes ?? 5_000_000;

  const toDocument = async (file: string, size: number): Promise<SourceDocument> => {
    const bytes = await readFile(file);
    return {
      sourceUri: file,
      contentHash: createHash('sha256').update(bytes).digest('hex'),
      text: bytes.toString('utf8'),
      metadata: { bytes: size, ext: extname(file).toLowerCase() },
    };
  };

  return {
    async *load(source: string): AsyncIterable<SourceDocument> {
      const root = resolve(source);
      const info = await stat(root);

      if (info.isFile()) {
        if (extensions.has(extname(root).toLowerCase()) && info.size <= maxBytes) {
          yield await toDocument(root, info.size);
        }
        return;
      }

      for await (const file of walk(root)) {
        if (!extensions.has(extname(file).toLowerCase())) continue;
        const fileInfo = await stat(file);
        if (fileInfo.size > maxBytes) continue;
        yield await toDocument(file, fileInfo.size);
      }
    },
  };
}
