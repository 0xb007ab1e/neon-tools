-- Reverse of 0002_fts.
DROP INDEX IF EXISTS vn_chunks_tsv_idx;
ALTER TABLE vn_chunks DROP COLUMN IF EXISTS tsv;
