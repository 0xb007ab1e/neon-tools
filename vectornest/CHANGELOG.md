# Changelog

All notable changes to VectorNest are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com); the project uses [SemVer](https://semver.org).

## [Unreleased]

Pre-1.0 development. Everything below ships on `main` and is live-validated against Neon + an
OpenAI-compatible embeddings provider.

### Added

- **RAG core:** ingest (chunk → embed → store, idempotent + resumable) and semantic query.
- **Three retrieval modes:** `vector` (pgvector kNN), `keyword` (Postgres full-text), and `hybrid`
  (Reciprocal Rank Fusion of both).
- **Model-versioned embeddings** with **zero-downtime model swaps**: re-embed a new model alongside
  the live one, then flip the active model atomically; instant rollback; drop retired models.
- **Branch rehearsal:** re-embed + evaluate a candidate model on a throwaway Neon branch before
  touching production (Neon API).
- **Evaluation + swap gate:** recall@k / MRR against a labeled query set; gate a swap on quality.
- **Per-model HNSW indexes** (partial expression indexes over the dimension-cast vectors).
- **Four entrypoints:** library, CLI, MCP server (stdio), and HTTP API (Hono).
- **Security:** explicit verified TLS to Postgres; HTTP bearer auth, zod validation, RFC 9457
  errors, fail-closed; secrets only from the environment.
- **Docs:** full guide set under [`docs/`](./docs/), `openapi.yaml`, and a TypeDoc API reference
  (`pnpm --filter vectornest run docs`).

### Notes

- Versions are `0.0.0` (pre-release). The public API and schema may change before 1.0.
