-- 0001_init: VectorNest core schema.
-- Forward migration; reverse with 0001_init.down.sql. Design: ARCHITECTURE.md §4.
-- Idempotent (IF NOT EXISTS) so re-running against an existing branch is safe.

CREATE EXTENSION IF NOT EXISTS vector;

-- Logical namespaces. Becomes the per-tenant scope when VectorNest grows into TenantForge.
CREATE TABLE IF NOT EXISTS vn_collections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Source documents. content_hash gives ingest idempotency (skip unchanged docs) per collection.
CREATE TABLE IF NOT EXISTS vn_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id uuid NOT NULL REFERENCES vn_collections (id) ON DELETE CASCADE,
  source_uri    text NOT NULL,
  content_hash  text NOT NULL,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vn_documents_collection_hash_uniq UNIQUE (collection_id, content_hash)
);
CREATE INDEX IF NOT EXISTS vn_documents_collection_idx ON vn_documents (collection_id);

-- Chunks of a document; ordinal preserves order within the document.
CREATE TABLE IF NOT EXISTS vn_chunks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL REFERENCES vn_documents (id) ON DELETE CASCADE,
  ordinal      integer NOT NULL CHECK (ordinal >= 0),
  text         text NOT NULL,
  token_count  integer CHECK (token_count IS NULL OR token_count >= 0),
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vn_chunks_document_ordinal_uniq UNIQUE (document_id, ordinal)
);
CREATE INDEX IF NOT EXISTS vn_chunks_document_idx ON vn_chunks (document_id);

-- Registered embedding models. At most one is active (the query + swap target).
CREATE TABLE IF NOT EXISTS vn_embedding_models (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,   -- e.g. 'openai/text-embedding-3-small'
  provider    text NOT NULL,          -- gateway provider segment, e.g. 'openai'
  dim         integer NOT NULL CHECK (dim > 0),
  is_active   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- Enforce a single active model: unique over the active rows only.
CREATE UNIQUE INDEX IF NOT EXISTS vn_embedding_models_one_active
  ON vn_embedding_models (is_active) WHERE is_active;

-- Model-versioned embeddings: vectors for old + new models coexist, so a re-embed adds rows
-- alongside the live model and the zero-downtime "swap" is just an is_active flip (ARCHITECTURE §5).
--
-- `vector` is intentionally dimensionless so models of differing dims share one table. Every query
-- scopes to a single model_id, so the vectors it compares always share a dimension. ANN indexes
-- (HNSW per model) are created by the Month-1 re-embed flow; v1 query uses exact kNN, which needs
-- no index and is correct for the low-volume corpora the walking skeleton targets.
CREATE TABLE IF NOT EXISTS vn_embeddings (
  chunk_id    uuid NOT NULL REFERENCES vn_chunks (id) ON DELETE CASCADE,
  model_id    uuid NOT NULL REFERENCES vn_embedding_models (id) ON DELETE CASCADE,
  embedding   vector NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chunk_id, model_id)
);
CREATE INDEX IF NOT EXISTS vn_embeddings_model_idx ON vn_embeddings (model_id);
