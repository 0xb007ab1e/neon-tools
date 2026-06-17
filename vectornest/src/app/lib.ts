import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EmbeddingModel, QueryHit, Vector } from '../core/domain.js';
import {
  type ChunkOptions,
  assertActivatable,
  chunkText,
  knownDimension,
  parseModelName,
} from '../core/index.js';
import { createOpenAiCompatibleEmbeddingProvider } from '../adapters/openai-compatible/embedding-provider.js';
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

/** Options for a re-embed run. */
export interface ReembedOptions {
  /** Embedding dimension; defaults to the known dimension for the model. */
  dim?: number;
  /** Activate the model once fully embedded (the zero-downtime swap). Default false. */
  activate?: boolean;
}

/** Result of a re-embed run. */
export interface ReembedSummary {
  /** The target model. */
  model: string;
  /** Chunks embedded during this run. */
  embedded: number;
  /** Total chunks in the corpus. */
  total: number;
  /** Chunks the model now has embeddings for. */
  coverage: number;
  /** Whether the model was activated (swapped in). */
  activated: boolean;
}

/** A registered model annotated with its embedding coverage. */
export interface ModelInfo extends EmbeddingModel {
  /** Chunks this model has embeddings for. */
  coverage: number;
  /** Total chunks in the corpus. */
  total: number;
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
  /**
   * Re-embed the corpus under a (possibly new) model, alongside the active one — idempotent and
   * resumable. Optionally activate it once fully embedded (the zero-downtime swap).
   *
   * @param modelName - The provider/model string to embed with.
   * @param options - Dimension and whether to activate.
   * @returns A summary of the run.
   */
  reembed(modelName: string, options?: ReembedOptions): Promise<ReembedSummary>;
  /**
   * Activate a fully-embedded registered model (the swap; also used to roll back to a prior model).
   *
   * @param modelName - The model to make active.
   */
  activateModel(modelName: string): Promise<void>;
  /**
   * Delete a non-active model's embeddings (cleanup after a confirmed swap).
   *
   * @param modelName - The model whose embeddings to drop.
   * @returns The number of embedding rows removed.
   */
  dropModel(modelName: string): Promise<number>;
  /**
   * List registered models with their coverage and active status.
   *
   * @returns Model info records.
   */
  models(): Promise<ModelInfo[]>;
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
  /** Build an embedding provider for an arbitrary model + dim (used by re-embed). */
  createEmbedder: (model: string, dim: number) => EmbeddingProvider;
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
 * Provider segment of a model name. Slash-delimited names (`openai/…`, `@cf/…`) yield a provider;
 * bare names (Ollama, e.g. `nomic-embed-text`) use the whole name.
 *
 * @param modelName - The provider/model string.
 * @returns The provider segment.
 */
function providerOf(modelName: string): string {
  return modelName.includes('/') ? parseModelName(modelName).provider : modelName;
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
  const registered = await store.registerModel({
    name: embedder.model,
    provider: providerOf(embedder.model),
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
  const { store, embedder, loader, createEmbedder, embedBatchSize } = deps;

  // Always embed with the *active* model's provider: after a swap the active model may differ
  // (and have a different dimension) from the configured default. Reuse the default when it matches.
  const embedderFor = (model: EmbeddingModel): EmbeddingProvider =>
    model.name === embedder.model && model.dim === embedder.dim
      ? embedder
      : createEmbedder(model.name, model.dim);

  return {
    migrate() {
      return store.migrate();
    },

    async ingest(source: string, options: IngestOptions): Promise<IngestSummary> {
      const skipUnchanged = options.skipUnchanged ?? true;
      const collection = await store.ensureCollection(options.collection);
      const model = await ensureActiveModel(store, embedder);
      const activeEmbedder = embedderFor(model);

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
          activeEmbedder,
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
      const [vector] = await embedderFor(model).embed([text]);
      if (!vector) {
        throw new Error('failed to embed query');
      }
      if (request.collection !== undefined) {
        const collection = await store.ensureCollection(request.collection);
        return store.query(model.id, vector, { k, collectionId: collection.id });
      }
      return store.query(model.id, vector, { k });
    },

    async reembed(modelName: string, options: ReembedOptions = {}): Promise<ReembedSummary> {
      const dim = options.dim ?? knownDimension(modelName);
      if (dim === undefined) {
        throw new Error(`unknown embedding dimension for "${modelName}"; pass options.dim`);
      }
      const model = await store.registerModel({
        name: modelName,
        provider: providerOf(modelName),
        dim,
      });
      const target = createEmbedder(modelName, dim);

      // Embed only chunks this model lacks; persisting each batch shrinks the set, so this is
      // idempotent and resumable. Vectors are added alongside the active model — no downtime.
      let embedded = 0;
      for (;;) {
        const batch = await store.getUnembeddedChunks(model.id, embedBatchSize);
        if (batch.length === 0) break;
        const vectors = await target.embed(batch.map((chunk) => chunk.text));
        const rows: EmbeddingRow[] = [];
        for (let i = 0; i < batch.length; i += 1) {
          const chunk = batch[i];
          const vector = vectors[i];
          if (!chunk || !vector) {
            throw new Error('internal: chunk/embedding count mismatch during re-embed');
          }
          rows.push({ chunkId: chunk.chunkId, vector });
        }
        await store.upsertEmbeddings(model.id, rows);
        embedded += batch.length;
      }

      const total = await store.countChunks();
      const coverage = await store.countEmbeddings(model.id);
      let activated = false;
      if (options.activate) {
        assertActivatable(modelName, { total, embedded: coverage });
        await store.setActiveModel(model.id);
        activated = true;
      }
      return { model: modelName, embedded, total, coverage, activated };
    },

    async activateModel(modelName: string): Promise<void> {
      const model = await store.getModelByName(modelName);
      if (!model) {
        throw new Error(`model "${modelName}" is not registered`);
      }
      const total = await store.countChunks();
      const coverage = await store.countEmbeddings(model.id);
      assertActivatable(modelName, { total, embedded: coverage });
      await store.setActiveModel(model.id);
    },

    async dropModel(modelName: string): Promise<number> {
      const model = await store.getModelByName(modelName);
      if (!model) {
        throw new Error(`model "${modelName}" is not registered`);
      }
      if (model.isActive) {
        throw new Error(`refusing to drop embeddings for the active model "${modelName}"`);
      }
      return store.deleteEmbeddings(model.id);
    },

    async models(): Promise<ModelInfo[]> {
      const registered = await store.listModels();
      const total = await store.countChunks();
      const result: ModelInfo[] = [];
      for (const model of registered) {
        const coverage = await store.countEmbeddings(model.id);
        result.push({ ...model, coverage, total });
      }
      return result;
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
 * @returns A ready VectorNest backed by Neon + the embeddings endpoint + the filesystem loader.
 */
export function vectorNestFromConfig(config: Config): VectorNest {
  const store = createNeonPgVectorStore({
    connectionString: config.databaseUrl,
    migrationsDir,
  });
  const createEmbedder = (model: string, dim: number): EmbeddingProvider =>
    createOpenAiCompatibleEmbeddingProvider({
      baseUrl: config.embeddingsBaseUrl,
      model,
      dim,
      maxBatchSize: config.embedBatchSize,
      ...(config.embeddingsApiKey !== undefined ? { apiKey: config.embeddingsApiKey } : {}),
    });
  const embedder = createEmbedder(config.model, config.dim);
  const loader = createFsLoader();
  return createVectorNest({
    store,
    embedder,
    createEmbedder,
    loader,
    embedBatchSize: config.embedBatchSize,
  });
}
