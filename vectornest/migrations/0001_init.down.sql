-- Reverse of 0001_init. Drops VectorNest core tables (children first via CASCADE-safe order).
-- The `vector` extension is left installed: it may be shared by other schemas on the database.

DROP TABLE IF EXISTS vn_embeddings;
DROP TABLE IF EXISTS vn_embedding_models;
DROP TABLE IF EXISTS vn_chunks;
DROP TABLE IF EXISTS vn_documents;
DROP TABLE IF EXISTS vn_collections;
