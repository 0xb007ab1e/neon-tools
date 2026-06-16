import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EmbeddingModel, QueryHit, Vector } from '../core/domain.js';
import { type ChunkOptions, chunkText, parseModelName } from '../core/index.js';
import { createAiGatewayEmbeddingProvider } from '../adapters/ai-gateway/embedding-provider.js';
import { createFsLoader } from '../adapters/loaders/fs-loader.js';
import { createNeonPgVectorStore } from '../adapters/neon-pg/vector-store.js';
import type { DocumentLoader } from '../ports/document-loader.js';
import type { EmbeddingProvider } from '../ports/embedding-provider.js';
import type { EmbeddingRow, VectorStore } from '../ports/vector-store.js';
import type { Config } from './config.js';

/** Options for an ingest run. */
export interface IngestOptions {
  /** Target collection name. */
  collection: string;
  /** Chunking parameters (defaults to the core defaults). */
  chunkOptions?: ChunkOptions;
  /** Skip documents whose content hash is already ingested (default true). */
  skipUnchanged?: boolean;
}

/** Tally returned by an ingest run. */
export interface IngestSummary {
  /** Documents ingested (excluding skipped). */
  documents: number;
  /** Chunks embedded and stored. */
  chunks: number;
  /** Documents skipped as unchanged. */
  skipped: number;
}

/** Options for a query. */
export interface QueryRequest {
  /** Optional collection scope. */
  collection?: string;
  /** Number of hits to return (1..100, default 5). */
  k?: number;
}

/** The VectorNest application service: the high-level ingest/query API. */
export interface VectorNest {
  /** Apply pending schema migrations. */
  migrate(): Promise<void>;
  /**
   * Ingest documents from a source into a collection.
   *
   * @param source - Loader source (e.g. a directory path).
   * @param options - Collection and chunking options.
   * @returns A tally of documents/chunks/skips.
   */
  ingest(source: string, options: IngestOptions): Promise<IngestSummary>;
  /**
   * Semantic search over a collection.
   *
   * @param text - The query text.
   * @param request - Collection scope and k.
   * @returns Hits ordered by descending similarity.
   */
  query(text: string, request?: QueryRequest): Promise<QueryHit[]>;
  /** Release underlying resources. */
  close(): Promise<void>;
}

/** Collaborators for {@link createVectorNest} (injected for testability). */
export interface VectorNestDeps {
  /** The vector store. */
  store: VectorStore;
  /** The embedding provider. */
  embedder: EmbeddingProvider;
  /** The document loader. */
  loader: DocumentLoader;
  /** Max texts per embedding request. */
  embedBatchSize: number;
}

/** Resolve the migrations directory relative to this module (works from src/ and dist/). */
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

/**
 * Embed texts in bounded batches, preserving order.
 *
 * @param embedder - The embedding provider.
 * @param texts - Texts to embed.
 * @param batchSize - Max texts per request.
 * @returns Vectors aligned to `texts`.
 */
async function embedAll(
  embedder: EmbeddingProvider,
  texts: string[],
  batchSize: number,
): Promise<Vector[]> {
  const vectors: Vector[] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    vectors.push(...(await embedder.embed(texts.slice(i, i + batchSize))));
  }
  return vectors;
}

/**
 * Ensure the embedder's model is registered and active, returning it.
 *
 * @param store - The vector store.
 * @param embedder - The embedding provider (source of model name + dim).
 * @returns The active embedding model.
 */
async function ensureActiveModel(
  store: VectorStore,
  embedder: EmbeddingProvider,
): Promise<EmbeddingModel> {
  const active = await store.getActiveModel();
  if (active && active.name === embedder.model) return active;
  const { provider } = parseModelName(embedder.model);
  const registered = await store.registerModel({
    name: embedder.model,
    provider,
    dim: embedder.dim,
  });
  await store.setActiveModel(registered.id);
  return registered;
}

/**
 * Create a {@link VectorNest} from injected collaborators (the use-case layer).
 *
 * @param deps - Store, embedder, loader, and batch size.
 * @returns The application service.
 */
export function createVectorNest(deps: VectorNestDeps): VectorNest {
  const { store, embedder, loader, embedBatchSize } = deps;

  return {
    migrate() {
      return store.migrate();
    },

    async ingest(source: string, options: IngestOptions): Promise<IngestSummary> {
      const skipUnchanged = options.skipUnchanged ?? true;
      const collection = await store.ensureCollection(options.collection);
      const model = await ensureActiveModel(store, embedder);

      const summary: IngestSummary = { documents: 0, chunks: 0, skipped: 0 };
      for await (const doc of loader.load(source)) {
        if (skipUnchanged && (await store.documentExists(collection.id, doc.contentHash))) {
          summary.skipped += 1;
          continue;
        }
        const { documentId } = await store.upsertDocument(collection.id, {
          sourceUri: doc.sourceUri,
          contentHash: doc.contentHash,
          metadata: doc.metadata,
        });
        const chunks = chunkText(doc.text, options.chunkOptions);
        summary.documents += 1;
        if (chunks.length === 0) continue;

        const stored = await store.upsertChunks(documentId, chunks);
        const vectors = await embedAll(
          embedder,
          chunks.map((c) => c.text),
          embedBatchSize,
        );

        const rows: EmbeddingRow[] = [];
        for (let i = 0; i < stored.length; i += 1) {
          const chunk = stored[i];
          const vector = vectors[i];
          if (!chunk || !vector) {
            throw new Error('internal: chunk/embedding count mismatch during ingest');
          }
          rows.push({ chunkId: chunk.chunkId, vector });
        }
        await store.upsertEmbeddings(model.id, rows);
        summary.chunks += chunks.length;
      }
      return summary;
    },

    async query(text: string, request: QueryRequest = {}): Promise<QueryHit[]> {
      const k = request.k ?? 5;
      if (!Number.isInteger(k) || k < 1 || k > 100) {
        throw new RangeError('k must be an integer in 1..100');
      }
      const model = await store.getActiveModel();
      if (!model) {
        throw new Error('no active embedding model; run ingest first');
      }
      const [vector] = await embedder.embed([text]);
      if (!vector) {
        throw new Error('failed to embed query');
      }
      if (request.collection !== undefined) {
        const collection = await store.ensureCollection(request.collection);
        return store.query(model.id, vector, { k, collectionId: collection.id });
      }
      return store.query(model.id, vector, { k });
    },

    close() {
      return store.close();
    },
  };
}

/**
 * Composition root: wire the production adapters from validated config.
 *
 * @param config - Validated configuration.
 * @returns A ready VectorNest backed by Neon + the AI Gateway + the filesystem loader.
 */
export function vectorNestFromConfig(config: Config): VectorNest {
  const store = createNeonPgVectorStore({
    connectionString: config.databaseUrl,
    migrationsDir,
  });
  const embedder = createAiGatewayEmbeddingProvider({ model: config.model, dim: config.dim });
  const loader = createFsLoader();
  return createVectorNest({ store, embedder, loader, embedBatchSize: config.embedBatchSize });
}
