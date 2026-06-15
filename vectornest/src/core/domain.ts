/**
 * Pure domain types for VectorNest.
 *
 * These describe the entities and value objects the core reasons about. They carry no I/O and
 * no framework coupling, so the core and the port contracts can share them freely.
 */

/** A JSON-serialisable value (matches what Postgres `jsonb` round-trips). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A JSON object, e.g. document/chunk metadata. */
export type JsonObject = { [key: string]: JsonValue };

/** A dense embedding vector. Length always equals the producing model's {@link EmbeddingModel.dim}. */
export type Vector = number[];

/** A logical namespace for documents (the future per-tenant scope). */
export interface Collection {
  /** Stable identifier (UUID). */
  id: string;
  /** Unique human-readable name. */
  name: string;
  /** Free-form metadata. */
  metadata: JsonObject;
}

/**
 * A source document as produced by a {@link DocumentLoader}, before chunking.
 *
 * `contentHash` is computed by the loader from the raw bytes and drives ingest idempotency.
 */
export interface SourceDocument {
  /** Where the document came from (file path, URL, …). */
  sourceUri: string;
  /** Stable content hash of the raw bytes (idempotency key within a collection). */
  contentHash: string;
  /** Extracted text content. */
  text: string;
  /** Free-form metadata (e.g. mime type, title). */
  metadata: JsonObject;
}

/** A contiguous chunk of a document's text, ready to embed. */
export interface Chunk {
  /** Zero-based position within the document. */
  ordinal: number;
  /** The chunk text. */
  text: string;
  /** Optional token count (provider/tokenizer dependent). */
  tokenCount?: number;
  /** Free-form metadata. */
  metadata: JsonObject;
}

/** A registered embedding model; at most one is active at a time. */
export interface EmbeddingModel {
  /** Stable identifier (UUID). */
  id: string;
  /** Provider/model string, e.g. `openai/text-embedding-3-small`. */
  name: string;
  /** Provider segment, e.g. `openai`. */
  provider: string;
  /** Embedding dimension. */
  dim: number;
  /** Whether this model currently serves queries (the swap target). */
  isActive: boolean;
}

/** A single semantic-search result. */
export interface QueryHit {
  /** The matched chunk's id. */
  chunkId: string;
  /** The owning document's id. */
  documentId: string;
  /** The owning document's source URI. */
  sourceUri: string;
  /** The chunk's position within its document. */
  ordinal: number;
  /** The chunk text. */
  text: string;
  /** Similarity score in [0, 1] (cosine similarity; higher is closer). */
  score: number;
  /** The chunk's metadata. */
  metadata: JsonObject;
}
