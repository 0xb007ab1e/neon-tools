import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EmbeddingModel, QueryHit, Vector } from '../core/domain.js';
import {
  type ChunkOptions,
  assertActivatable,
  chunkText,
  isFullyEmbedded,
  knownDimension,
  parseModelName,
} from '../core/index.js';
import { createOpenAiCompatibleEmbeddingProvider } from '../adapters/openai-compatible/embedding-provider.js';
import { createFsLoader } from '../adapters/loaders/fs-loader.js';
import { createNeonBranchManager } from '../adapters/neon-api/branch-manager.js';
import { createNeonPgVectorStore } from '../adapters/neon-pg/vector-store.js';
import type { BranchManager } from '../ports/branch-manager.js';
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
  /** Rehearse on a throwaway Neon branch first; abort if it doesn't fully embed. Default false. */
  rehearse?: boolean;
}

/** Options for a rehearsal run. */
export interface RehearseOptions {
  /** Embedding dimension; defaults to the known dimension for the model. */
  dim?: number;
}

/** Result of a branch rehearsal. */
export interface RehearseSummary {
  /** The model that was rehearsed. */
  model: string;
  /** The ephemeral branch id used (already deleted by the time this returns). */
  branchId: string;
  /** Chunks embedded on the branch. */
  embedded: number;
  /** Total chunks on the branch. */
  total: number;
  /** Chunks the model covered on the branch. */
  coverage: number;
  /** Whether the model fully embedded the corpus (the pass/fail signal). */
  complete: boolean;
  /** Wall-clock duration of the rehearsal in milliseconds. */
  elapsedMs: number;
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
   * Rehearse a model on a throwaway, copy-on-write Neon branch — re-embed the corpus there to
   * validate dimensions/coverage and estimate time, without touching production. The branch is
   * always deleted afterward. Requires Neon API credentials.
   *
   * @param modelName - The provider/model string to rehearse.
   * @param options - Dimension override.
   * @returns The rehearsal report (coverage, completeness, elapsed time).
   */
  rehearse(modelName: string, options?: RehearseOptions): Promise<RehearseSummary>;
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
  /** Build a vector store for an arbitrary connection string (used by branch rehearsal). */
  createStore?: (connectionString: string) => VectorStore;
  /** Manages ephemeral Neon branches (enables rehearsal). */
  branchManager?: BranchManager;
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

/** Outcome of embedding a corpus under a model in a given store. */
interface ReembedResult {
  /** The model's id. */
  modelId: string;
  /** Chunks embedded this run. */
  embedded: number;
  /** Total chunks in the store. */
  total: number;
  /** Chunks the model now covers. */
  coverage: number;
}

/**
 * Register `modelName` in `store` and embed every chunk it lacks (idempotent, resumable). Shared by
 * production re-embed and branch rehearsal — only the store differs.
 *
 * @param store - Target store (production or a branch).
 * @param createEmbedder - Embedding provider factory.
 * @param embedBatchSize - Max texts per embedding request.
 * @param modelName - The model to embed under.
 * @param dim - The model's embedding dimension.
 * @returns The model id and coverage counts.
 */
async function reembedInto(
  store: VectorStore,
  createEmbedder: (model: string, dim: number) => EmbeddingProvider,
  embedBatchSize: number,
  modelName: string,
  dim: number,
): Promise<ReembedResult> {
  const model = await store.registerModel({
    name: modelName,
    provider: providerOf(modelName),
    dim,
  });
  const target = createEmbedder(modelName, dim);

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
  return { modelId: model.id, embedded, total, coverage };
}

/**
 * Create a {@link VectorNest} from injected collaborators (the use-case layer).
 *
 * @param deps - Store, embedder, loader, and batch size.
 * @returns The application service.
 */
export function createVectorNest(deps: VectorNestDeps): VectorNest {
  const { store, embedder, loader, createEmbedder, createStore, branchManager, embedBatchSize } =
    deps;

  // Always embed with the *active* model's provider: after a swap the active model may differ
  // (and have a different dimension) from the configured default. Reuse the default when it matches.
  const embedderFor = (model: EmbeddingModel): EmbeddingProvider =>
    model.name === embedder.model && model.dim === embedder.dim
      ? embedder
      : createEmbedder(model.name, model.dim);

  /** Re-embed `modelName` on a throwaway branch and report, always deleting the branch. */
  const runRehearsal = async (modelName: string, dim: number): Promise<RehearseSummary> => {
    if (!branchManager || !createStore) {
      throw new Error(
        'rehearsal requires Neon API credentials (set NEON_API_KEY and NEON_PROJECT_ID)',
      );
    }
    const safeName = modelName.replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    const branch = await branchManager.createBranch(
      `vectornest-rehearse-${safeName}-${Date.now()}`,
    );
    const start = Date.now();
    try {
      const branchStore = createStore(branch.connectionUri);
      try {
        await branchStore.migrate(); // branch is copy-on-write; migrate is idempotent.
        const result = await reembedInto(
          branchStore,
          createEmbedder,
          embedBatchSize,
          modelName,
          dim,
        );
        return {
          model: modelName,
          branchId: branch.branchId,
          embedded: result.embedded,
          total: result.total,
          coverage: result.coverage,
          complete: isFullyEmbedded({ total: result.total, embedded: result.coverage }),
          elapsedMs: Date.now() - start,
        };
      } finally {
        await branchStore.close();
      }
    } finally {
      await branchManager.deleteBranch(branch.branchId);
    }
  };

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

      // Optionally validate on a throwaway branch before touching production.
      if (options.rehearse) {
        const rehearsal = await runRehearsal(modelName, dim);
        if (!rehearsal.complete) {
          throw new Error(
            `rehearsal for "${modelName}" only embedded ${rehearsal.coverage}/${rehearsal.total} chunks — aborting production re-embed`,
          );
        }
      }

      // Production re-embed: vectors land alongside the active model — no downtime.
      const result = await reembedInto(store, createEmbedder, embedBatchSize, modelName, dim);
      let activated = false;
      if (options.activate) {
        assertActivatable(modelName, { total: result.total, embedded: result.coverage });
        await store.setActiveModel(result.modelId);
        activated = true;
      }
      return {
        model: modelName,
        embedded: result.embedded,
        total: result.total,
        coverage: result.coverage,
        activated,
      };
    },

    async rehearse(modelName: string, options: RehearseOptions = {}): Promise<RehearseSummary> {
      const dim = options.dim ?? knownDimension(modelName);
      if (dim === undefined) {
        throw new Error(`unknown embedding dimension for "${modelName}"; pass options.dim`);
      }
      return runRehearsal(modelName, dim);
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
  const createStore = (connectionString: string): VectorStore =>
    createNeonPgVectorStore({ connectionString, migrationsDir });
  const store = createStore(config.databaseUrl);

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

  // Branch rehearsal is available only when Neon API credentials are configured.
  const branchManager =
    config.neonApiKey !== undefined && config.neonProjectId !== undefined
      ? createNeonBranchManager({
          apiKey: config.neonApiKey,
          projectId: config.neonProjectId,
          ...(config.neonApiBaseUrl !== undefined ? { baseUrl: config.neonApiBaseUrl } : {}),
        })
      : undefined;

  return createVectorNest({
    store,
    embedder,
    createEmbedder,
    createStore,
    loader,
    embedBatchSize: config.embedBatchSize,
    ...(branchManager !== undefined ? { branchManager } : {}),
  });
}
