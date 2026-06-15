# VectorNest

> **Consolidate your separate vector database into the Neon Postgres you already run.**
> RAG ingest + query with pgvector, plus safe, branch-rehearsed re-embedding and zero-downtime
> model swaps. One database, one bill, transactional consistency — no Pinecone subscription, no
> relational↔vector sync.

**Status:** `scaffold` — v1 architecture and scope are designed; implementation not started.
See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full design and milestones.

## Why

A dedicated vector DB (Pinecone ~$70+/mo, Weaviate ~$135+/mo at ~10M vectors) means a second bill
*and* a dual-write pipeline keeping it in sync with your source-of-truth Postgres. VectorNest keeps
vectors in the same Neon Postgres — so the vector store is consistent with your data by construction.
Its edge over plain pgvector (Supabase/RDS) is the **workflow**: safe re-embedding rehearsed on a
Neon branch, then swapped atomically with zero downtime.

## What v1 does

- **Ingest** documents → chunk → embed → store (idempotent, resumable).
- **Query** semantic kNN + metadata filters (optional hybrid with Postgres full-text search).
- **Re-embed** on a Neon branch to rehearse + eval a new model, then **swap the active model with
  zero downtime** (old vectors keep serving until the flip).
- **Eval** a query set (recall@k, latency) to gate a model swap.
- Use it as a **library**, a **CLI**, or an **MCP server** (so agents/harnesses can call it).

## Quickstart (planned — week-1 target)

```bash
cp .env.example .env          # set DATABASE_URL + AI_GATEWAY_API_KEY
pnpm install
pnpm --filter vectornest cli ingest ./docs
pnpm --filter vectornest cli query "how does re-embedding work?"
```

## Configuration

Secrets come from the environment (never committed). See [`.env.example`](./.env.example) and the
`env` block in [`neon-tool.json`](./neon-tool.json): `DATABASE_URL`, `AI_GATEWAY_API_KEY` (required),
`NEON_API_KEY` + `NEON_PROJECT_ID` (for branch-based re-embed).

## Discoverability

This tool publishes [`neon-tool.json`](./neon-tool.json) per the collection's
[discovery convention](../TOOLS.md). Harnesses find it by globbing `**/neon-tool.json`; agents can
invoke it via its MCP server (`vn_ingest`, `vn_query`, `vn_reembed`, `vn_eval`, `vn_collections`).

## Project rules

This tool inherits the collection's [`CLAUDE.md`](./CLAUDE.md) (TypeScript service template + SSDLC).
