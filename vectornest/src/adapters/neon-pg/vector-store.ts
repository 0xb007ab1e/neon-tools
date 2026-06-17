import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import type {
  Chunk,
  Collection,
  EmbeddingModel,
  JsonObject,
  QueryHit,
  Vector,
} from '../../core/domain.js';
import { cosineDistanceToScore } from '../../core/ranking.js';
import type {
  ChunkText,
  EmbeddingRow,
  QueryOptions,
  StoredChunk,
  VectorStore,
} from '../../ports/vector-store.js';
import { buildPoolConfig } from './connection.js';
import { formatVector } from './serde.js';

const { Pool } = pg;

/** Configuration for the Neon Postgres + pgvector store. */
export interface NeonPgOptions {
  /** Postgres connection string (least-privilege role). */
  connectionString: string;
  /** Directory holding ordered `NNNN_*.sql` migration files. */
  migrationsDir: string;
}

interface ModelRow {
  id: string;
  name: string;
  provider: string;
  dim: number;
  is_active: boolean;
}

/**
 * Create a {@link VectorStore} backed by Neon Postgres + pgvector.
 *
 * All SQL is parameterized; vectors are passed as bound `::vector` parameters, never interpolated
 * (CWE-89). The pool should be closed via {@link VectorStore.close} on shutdown.
 *
 * @param options - Connection string and migrations directory.
 * @returns A connected vector store.
 */
export function createNeonPgVectorStore(options: NeonPgOptions): VectorStore {
  const pool = new Pool(buildPoolConfig(options.connectionString));

  const mapModel = (row: ModelRow): EmbeddingModel => ({
    id: row.id,
    name: row.name,
    provider: row.provider,
    dim: row.dim,
    isActive: row.is_active,
  });

  return {
    async migrate(): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query(
          `CREATE TABLE IF NOT EXISTS vn_schema_migrations (
             filename text PRIMARY KEY,
             applied_at timestamptz NOT NULL DEFAULT now()
           )`,
        );
        const files = (await readdir(options.migrationsDir))
          .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
          .sort();
        for (const filename of files) {
          const existing = await client.query(
            'SELECT 1 FROM vn_schema_migrations WHERE filename = $1',
            [filename],
          );
          if ((existing.rowCount ?? 0) > 0) continue;
          const sql = await readFile(join(options.migrationsDir, filename), 'utf8');
          await client.query('BEGIN');
          try {
            await client.query(sql);
            await client.query('INSERT INTO vn_schema_migrations (filename) VALUES ($1)', [
              filename,
            ]);
            await client.query('COMMIT');
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          }
        }
      } finally {
        client.release();
      }
    },

    async ensureCollection(name: string): Promise<Collection> {
      const { rows } = await pool.query<{ id: string; name: string; metadata: JsonObject }>(
        `INSERT INTO vn_collections (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET updated_at = now()
         RETURNING id, name, metadata`,
        [name],
      );
      const row = rows[0]!;
      return { id: row.id, name: row.name, metadata: row.metadata };
    },

    async registerModel(model: {
      name: string;
      provider: string;
      dim: number;
    }): Promise<EmbeddingModel> {
      const { rows } = await pool.query<ModelRow>(
        `INSERT INTO vn_embedding_models (name, provider, dim) VALUES ($1, $2, $3)
         ON CONFLICT (name) DO UPDATE SET provider = EXCLUDED.provider, dim = EXCLUDED.dim
         RETURNING id, name, provider, dim, is_active`,
        [model.name, model.provider, model.dim],
      );
      return mapModel(rows[0]!);
    },

    async getActiveModel(): Promise<EmbeddingModel | null> {
      const { rows } = await pool.query<ModelRow>(
        'SELECT id, name, provider, dim, is_active FROM vn_embedding_models WHERE is_active LIMIT 1',
      );
      return rows[0] ? mapModel(rows[0]) : null;
    },

    async getModelByName(name: string): Promise<EmbeddingModel | null> {
      const { rows } = await pool.query<ModelRow>(
        'SELECT id, name, provider, dim, is_active FROM vn_embedding_models WHERE name = $1',
        [name],
      );
      return rows[0] ? mapModel(rows[0]) : null;
    },

    async listModels(): Promise<EmbeddingModel[]> {
      const { rows } = await pool.query<ModelRow>(
        'SELECT id, name, provider, dim, is_active FROM vn_embedding_models ORDER BY created_at',
      );
      return rows.map(mapModel);
    },

    async setActiveModel(modelId: string): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('UPDATE vn_embedding_models SET is_active = false WHERE is_active');
        await client.query('UPDATE vn_embedding_models SET is_active = true WHERE id = $1', [
          modelId,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async documentExists(collectionId: string, contentHash: string): Promise<boolean> {
      const { rowCount } = await pool.query(
        'SELECT 1 FROM vn_documents WHERE collection_id = $1 AND content_hash = $2',
        [collectionId, contentHash],
      );
      return (rowCount ?? 0) > 0;
    },

    async upsertDocument(
      collectionId: string,
      doc: { sourceUri: string; contentHash: string; metadata: JsonObject },
    ): Promise<{ documentId: string; isNew: boolean }> {
      const { rows } = await pool.query<{ id: string; is_new: boolean }>(
        `INSERT INTO vn_documents (collection_id, source_uri, content_hash, metadata)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (collection_id, content_hash)
         DO UPDATE SET source_uri = EXCLUDED.source_uri, metadata = EXCLUDED.metadata, updated_at = now()
         RETURNING id, (xmax = 0) AS is_new`,
        [collectionId, doc.sourceUri, doc.contentHash, doc.metadata],
      );
      const row = rows[0]!;
      return { documentId: row.id, isNew: row.is_new };
    },

    async upsertChunks(documentId: string, chunks: Chunk[]): Promise<StoredChunk[]> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Replace the chunk set; embeddings cascade-delete via FK, so re-ingest is clean.
        await client.query('DELETE FROM vn_chunks WHERE document_id = $1', [documentId]);
        const stored: StoredChunk[] = [];
        for (const chunk of chunks) {
          const { rows } = await client.query<{ id: string; ordinal: number }>(
            `INSERT INTO vn_chunks (document_id, ordinal, text, token_count, metadata)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, ordinal`,
            [documentId, chunk.ordinal, chunk.text, chunk.tokenCount ?? null, chunk.metadata],
          );
          const row = rows[0]!;
          stored.push({ chunkId: row.id, ordinal: row.ordinal });
        }
        await client.query('COMMIT');
        return stored;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async upsertEmbeddings(modelId: string, rows: EmbeddingRow[]): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const row of rows) {
          await client.query(
            `INSERT INTO vn_embeddings (chunk_id, model_id, embedding)
             VALUES ($1, $2, $3::vector)
             ON CONFLICT (chunk_id, model_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
            [row.chunkId, modelId, formatVector(row.vector)],
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async countChunks(): Promise<number> {
      const { rows } = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM vn_chunks',
      );
      return Number(rows[0]?.count ?? '0');
    },

    async countEmbeddings(modelId: string): Promise<number> {
      const { rows } = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM vn_embeddings WHERE model_id = $1',
        [modelId],
      );
      return Number(rows[0]?.count ?? '0');
    },

    async getUnembeddedChunks(modelId: string, limit: number): Promise<ChunkText[]> {
      const { rows } = await pool.query<{ id: string; text: string }>(
        `SELECT c.id, c.text
         FROM vn_chunks c
         WHERE NOT EXISTS (
           SELECT 1 FROM vn_embeddings e WHERE e.chunk_id = c.id AND e.model_id = $1
         )
         ORDER BY c.id
         LIMIT $2`,
        [modelId, limit],
      );
      return rows.map((row) => ({ chunkId: row.id, text: row.text }));
    },

    async deleteEmbeddings(modelId: string): Promise<number> {
      const { rowCount } = await pool.query('DELETE FROM vn_embeddings WHERE model_id = $1', [
        modelId,
      ]);
      return rowCount ?? 0;
    },

    async query(modelId: string, queryVector: Vector, options: QueryOptions): Promise<QueryHit[]> {
      const params: unknown[] = [modelId, formatVector(queryVector)];
      let collectionFilter = '';
      if (options.collectionId !== undefined) {
        params.push(options.collectionId);
        collectionFilter = `AND d.collection_id = $${params.length}`;
      }
      params.push(options.k);
      const limitParam = `$${params.length}`;

      const { rows } = await pool.query<{
        chunk_id: string;
        document_id: string;
        source_uri: string;
        ordinal: number;
        text: string;
        metadata: JsonObject;
        distance: number;
      }>(
        `SELECT c.id AS chunk_id, d.id AS document_id, d.source_uri, c.ordinal, c.text, c.metadata,
                (e.embedding <=> $2::vector) AS distance
         FROM vn_embeddings e
         JOIN vn_chunks c ON c.id = e.chunk_id
         JOIN vn_documents d ON d.id = c.document_id
         WHERE e.model_id = $1 ${collectionFilter}
         ORDER BY e.embedding <=> $2::vector
         LIMIT ${limitParam}`,
        params,
      );

      return rows.map((row) => ({
        chunkId: row.chunk_id,
        documentId: row.document_id,
        sourceUri: row.source_uri,
        ordinal: row.ordinal,
        text: row.text,
        metadata: row.metadata,
        score: cosineDistanceToScore(Number(row.distance)),
      }));
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
