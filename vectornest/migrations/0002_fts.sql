-- 0002_fts: full-text search support for hybrid retrieval.
-- A generated tsvector over chunk text (auto-maintained for existing and future rows) plus a GIN
-- index, so keyword search can be fused with vector search (ARCHITECTURE §5).

ALTER TABLE vn_chunks
  ADD COLUMN IF NOT EXISTS tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED;

CREATE INDEX IF NOT EXISTS vn_chunks_tsv_idx ON vn_chunks USING gin (tsv);
