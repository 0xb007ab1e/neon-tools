/**
 * Adapters: concrete implementations of the ports (the imperative shell). Injected at the
 * composition root. These do I/O (Postgres, the AI Gateway, the filesystem) and are validated by
 * integration tests rather than unit coverage (ARCHITECTURE §3).
 */
export { createNeonPgVectorStore, type NeonPgOptions } from './neon-pg/vector-store.js';
export { formatVector, parseVector } from './neon-pg/serde.js';
export {
  createAiGatewayEmbeddingProvider,
  type AiGatewayOptions,
} from './ai-gateway/embedding-provider.js';
export { createFsLoader, type FsLoaderOptions } from './loaders/fs-loader.js';
