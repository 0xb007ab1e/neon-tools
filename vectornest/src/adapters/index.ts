/**
 * Adapters: concrete implementations of the ports (the imperative shell). Injected at the
 * composition root. These do I/O (Postgres, an OpenAI-compatible embeddings endpoint, the
 * filesystem). The I/O-heavy ones are validated by integration tests; the embedding adapter's
 * untrusted-response handling is unit-tested with an injected fetch (ARCHITECTURE §3).
 */
export { createNeonPgVectorStore, type NeonPgOptions } from './neon-pg/vector-store.js';
export { formatVector, parseVector } from './neon-pg/serde.js';
export {
  createOpenAiCompatibleEmbeddingProvider,
  type OpenAiCompatibleOptions,
} from './openai-compatible/embedding-provider.js';
export { createFsLoader, type FsLoaderOptions } from './loaders/fs-loader.js';
