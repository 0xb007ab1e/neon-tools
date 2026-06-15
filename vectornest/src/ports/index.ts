/**
 * Ports: the interfaces the pure core owns and depends on. Adapters implement these and are
 * injected at the composition root (ports & adapters / hexagonal — ARCHITECTURE §3).
 */
export type { EmbeddingProvider } from './embedding-provider.js';
export type { DocumentLoader } from './document-loader.js';
export type { BranchManager } from './branch-manager.js';
export type { VectorStore, StoredChunk, EmbeddingRow, QueryOptions } from './vector-store.js';
