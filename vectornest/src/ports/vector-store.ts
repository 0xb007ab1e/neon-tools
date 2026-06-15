import type {
  Chunk,
  Collection,
  EmbeddingModel,
  JsonObject,
  QueryHit,
  Vector,
} from '../core/domain.js';

/** A chunk persisted by the store, with its assigned id and ordinal. */
export interface StoredChunk {
  /** The chunk's id (UUID). */
  chunkId: string;
  /** The chunk's position within its document. */
  ordinal: number;
}

/** One embedding row to persist: a chunk's vector under a given model. */
export interface EmbeddingRow {
  /** The chunk this vector embeds. */
  chunkId: string;
  /** The embedding vector (length must equal the model's dim). */
  vector: Vector;
}

/** Options for a semantic query. */
export interface QueryOptions {
  /** Maximum number of hits to return. */
  k: number;
  /** Optional collection scope; when omitted, searches across all collections. */
  collectionId?: string;
}

/**
 * Port: persistence + retrieval for collections, documents, chunks, and model-versioned embeddings.
 *
 * Backed by Neon Postgres + pgvector in production. All SQL behind this port is parameterized;
 * implementations never build queries by string concatenation.
 */
export interface VectorStore {
  /** Apply pending schema migrations idempotently. */
  migrate(): Promise<void>;

  /**
   * Get an existing collection by name or create it.
   *
   * @param name - The collection name.
   * @returns The existing or newly created collection.
   */
  ensureCollection(name: string): Promise<Collection>;

  /**
   * Register an embedding model (idempotent by name), returning the stored record.
   *
   * @param model - The model's name, provider, and dimension.
   * @returns The stored model record.
   */
  registerModel(model: { name: string; provider: string; dim: number }): Promise<EmbeddingModel>;

  /**
   * Return the currently active embedding model, or null if none is active.
   *
   * @returns The active model or null.
   */
  getActiveModel(): Promise<EmbeddingModel | null>;

  /**
   * Atomically make the given model the single active model.
   *
   * @param modelId - The model to activate.
   */
  setActiveModel(modelId: string): Promise<void>;

  /**
   * Whether a document with this content hash already exists in the collection (idempotency check).
   *
   * @param collectionId - The collection to check within.
   * @param contentHash - The document's content hash.
   * @returns True if an identical document is already ingested.
   */
  documentExists(collectionId: string, contentHash: string): Promise<boolean>;

  /**
   * Insert or update a document (keyed by collection + content hash) and return its id.
   *
   * @param collectionId - The owning collection.
   * @param doc - Source URI, content hash, and metadata.
   * @returns The document id and whether it was newly created.
   */
  upsertDocument(
    collectionId: string,
    doc: { sourceUri: string; contentHash: string; metadata: JsonObject },
  ): Promise<{ documentId: string; isNew: boolean }>;

  /**
   * Replace the chunk set for a document and return the stored chunks.
   *
   * @param documentId - The owning document.
   * @param chunks - Ordered chunks to persist.
   * @returns The persisted chunks with their ids.
   */
  upsertChunks(documentId: string, chunks: Chunk[]): Promise<StoredChunk[]>;

  /**
   * Persist embeddings for chunks under a model (idempotent on the chunk+model key).
   *
   * @param modelId - The model that produced the vectors.
   * @param rows - Chunk/vector pairs to store.
   */
  upsertEmbeddings(modelId: string, rows: EmbeddingRow[]): Promise<void>;

  /**
   * Semantic kNN search against a model's embeddings for a query vector.
   *
   * @param modelId - The model whose embedding space to search (its dim must match the vector).
   * @param queryVector - The embedded query.
   * @param options - k and optional collection scope.
   * @returns Hits ordered by descending similarity.
   */
  query(modelId: string, queryVector: Vector, options: QueryOptions): Promise<QueryHit[]>;

  /** Release underlying resources (connection pool). */
  close(): Promise<void>;
}
