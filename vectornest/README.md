# VectorNest

> **Consolidate your separate vector database into the Neon Postgres you already run.**
> RAG ingest + query with pgvector, three retrieval modes, and the part nobody else makes safe:
> **branch-rehearsed re-embedding with zero-downtime model swaps.** One database, one bill,
> transactional consistency — no Pinecone subscription, no relational↔vector sync pipeline.

**Status:** working. The full v1 + the safe-re-embedding workflow are implemented and
**live-validated** against Neon + an OpenAI-compatible embeddings provider (Cloudflare Workers AI
by default). See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the design.

## Why

A dedicated vector DB (Pinecone, Weaviate, …) is a second bill **and** a dual-write pipeline
keeping it in sync with your source-of-truth Postgres. VectorNest keeps vectors in the same Neon
Postgres, so the vector store is consistent with your data by construction. Its edge over plain
pgvector (Supabase/RDS) is the **workflow**: re-embed onto a cheap copy-on-write Neon branch,
evaluate it there, and only then swap the active model — atomically, with zero downtime and instant
rollback.

## Features

- **Ingest** a folder → chunk → embed → store. Idempotent (content-hash) and resumable.
- **Query** three ways: `vector` (pgvector kNN), `keyword` (Postgres full-text), or `hybrid`
  (Reciprocal Rank Fusion of both).
- **Model-versioned embeddings**: many models' vectors coexist; the active one is a single flag.
- **Re-embed** the corpus under a new model *alongside* the live one — no downtime.
- **Rehearse** a model on a throwaway Neon branch (re-embed + eval there) before touching prod.
- **Eval** a labeled query set (recall@k, MRR) and **gate** a swap on quality.
- **Zero-downtime swap** + instant **rollback** (old vectors are never removed until you drop them).
- **Per-model HNSW indexes** for approximate nearest-neighbor search at scale.
- Four entrypoints: **library**, **CLI**, **MCP server** (agent-discoverable), and **HTTP API**.

## Documentation

Full guides live in [`docs/`](./docs/):

- [Getting started](./docs/getting-started.md) — install → configure → first ingest + query.
- [Configuration](./docs/configuration.md) — every env var + Neon/Cloudflare/Ollama/Gemini setup.
- [CLI reference](./docs/cli-reference.md) · [Integration](./docs/integration.md) (library/HTTP/MCP) ·
  [Re-embedding & swaps](./docs/re-embedding.md) · [Troubleshooting](./docs/troubleshooting.md).
- API reference: `pnpm --filter vectornest run docs` → `docs/api/`. Design: [ARCHITECTURE.md](./ARCHITECTURE.md).

## Requirements

- Node ≥ 22, pnpm.
- A **Neon** Postgres database (free tier is fine — pgvector is available).
- An **OpenAI-compatible embeddings endpoint**. Default: Cloudflare Workers AI
  (`@cf/baai/bge-base-en-v1.5`, 768-dim). Ollama, Gemini, etc. work by changing two env vars.
- *(Optional)* A **Neon API key** + project id — only for branch rehearsal.

## Setup

```bash
pnpm install
cp .env.example .env     # then fill in the values below
```

`.env` (git-ignored):

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | ✅ | Neon connection string. |
| `EMBEDDINGS_BASE_URL` | ✅ | OpenAI-compatible base URL incl. `/v1` (e.g. `https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1`, or `http://localhost:11434/v1` for Ollama). |
| `EMBEDDINGS_API_KEY` | hosted only | Bearer token for the endpoint (omit for keyless local servers). |
| `VECTORNEST_MODEL` | – | Embedding model (default `@cf/baai/bge-base-en-v1.5`). |
| `VECTORNEST_EMBED_DIM` | – | Dimension, only if the model isn't in the built-in table. |
| `NEON_API_KEY`, `NEON_PROJECT_ID` | rehearsal only | Enable branch rehearsal. |

The CLI auto-loads `.env`. Run any command as `pnpm --filter vectornest cli <command>` (or, after
`pnpm --filter vectornest build`, the installed `vectornest` binary).

## Quickstart

```bash
pnpm --filter vectornest cli ingest ./docs --collection handbook
pnpm --filter vectornest cli query "how do refunds work?" --collection handbook
```

```text
ingested 12 document(s), 84 chunk(s); skipped 0
0.8417  ./docs/billing/refunds.md#2  Refunds are issued to the original payment method within…
0.7991  ./docs/billing/refunds.md#0  Our refund policy covers purchases made in the last 30 days…
0.7012  ./docs/billing/disputes.md#1  If a charge is disputed, the chargeback process…
```

## Demo walkthrough — safe model upgrade with zero downtime

The signature flow: you're serving queries on a small embedding model and want to upgrade to a
larger one **without risking quality or downtime**. (Uses the bundled sample corpus at
`test/integration/fixtures/` and eval set `test/integration/eval.json`.)

```bash
# 1. Ingest a corpus and confirm semantic search works on the default model.
pnpm --filter vectornest cli ingest ./test/integration/fixtures --collection demo
#   ingested 3 document(s), 3 chunk(s); skipped 0

pnpm --filter vectornest cli models
#   * @cf/baai/bge-base-en-v1.5  dim=768  coverage=3/3        ( * = active )

# 2. Try all three retrieval modes.
pnpm --filter vectornest cli query "how does Neon make idle databases free?" --collection demo --mode vector
pnpm --filter vectornest cli query "pgvector HNSW index"                      --collection demo --mode keyword
pnpm --filter vectornest cli query "vector search in postgres"                --collection demo --mode hybrid

# 3. Rehearse the bigger model on a throwaway Neon branch (production untouched),
#    re-embedding + evaluating there. Requires NEON_API_KEY + NEON_PROJECT_ID.
pnpm --filter vectornest cli rehearse @cf/baai/bge-large-en-v1.5
#   rehearsed @cf/baai/bge-large-en-v1.5 on branch br-… : 3/3 embedded in 2300ms — PASS

# 4. Re-embed in production, GATED on a rehearsal that must hit the quality bar,
#    and activate atomically once fully embedded (zero-downtime swap).
pnpm --filter vectornest cli reembed @cf/baai/bge-large-en-v1.5 \
     --rehearse --eval ./test/integration/eval.json --recall 1.0 --activate
#   re-embedded 3 chunk(s); coverage 3/3; ACTIVATED

pnpm --filter vectornest cli models
#     @cf/baai/bge-base-en-v1.5   dim=768   coverage=3/3
#   * @cf/baai/bge-large-en-v1.5  dim=1024  coverage=3/3

# 5. Not happy? Roll back instantly — the old model's vectors were never removed.
pnpm --filter vectornest cli activate @cf/baai/bge-base-en-v1.5
#   active model is now @cf/baai/bge-base-en-v1.5

# 6. Once confident, reclaim space from the retired model.
pnpm --filter vectornest cli drop-model @cf/baai/bge-large-en-v1.5
#   dropped 3 embedding row(s) for @cf/baai/bge-large-en-v1.5
```

You can also evaluate any registered model directly (exits non-zero below threshold, so it drops
into CI):

```bash
pnpm --filter vectornest cli eval @cf/baai/bge-base-en-v1.5 ./test/integration/eval.json --k 3 --recall 0.9
#   eval @cf/baai/bge-base-en-v1.5: recall@3=1.000 mrr=1.000 over 3 case(s) in 420ms — PASS
```

## CLI reference

| Command | Description |
|---|---|
| `migrate` | Apply schema migrations. |
| `ingest <path> [--collection]` | Ingest a file/directory into a collection. |
| `query <text> [--collection] [--k] [--mode vector\|keyword\|hybrid]` | Search. |
| `reembed <model> [--dim] [--activate] [--rehearse] [--eval <file>] [--recall] [--mrr]` | Re-embed under a model; optionally rehearse/eval-gate and swap. |
| `rehearse <model> [--dim]` | Rehearse on a throwaway Neon branch (needs Neon API creds). |
| `eval <model> <set.json> [--k] [--recall] [--mrr]` | Evaluate recall@k / MRR; exits 1 below thresholds. |
| `activate <model>` | Make a fully-embedded model active (swap / rollback). |
| `models` | List registered models with coverage (`*` = active). |
| `drop-model <model>` | Delete a non-active model's embeddings. |

An **eval set** is JSON: `[{ "query": "…", "relevant": ["source-uri-substring"] }]`.

## MCP server

Expose VectorNest to agents/harnesses over stdio:

```jsonc
// in your MCP client config
{
  "mcpServers": {
    "vectornest": {
      "command": "pnpm",
      "args": ["--filter", "vectornest", "mcp"]
    }
  }
}
```

Tools: `vn_ingest`, `vn_query` (supports `mode`), `vn_reembed`, `vn_eval`, `vn_collections`.

## Library

```ts
import { vectorNestFromConfig } from '@neon-tools/vectornest';
import { loadConfig } from '@neon-tools/vectornest/config'; // (via the package's exports)

const vn = vectorNestFromConfig(loadConfig());
await vn.migrate();
await vn.ingest('./docs', { collection: 'handbook' });
const hits = await vn.query('how do refunds work?', { collection: 'handbook', mode: 'hybrid' });
await vn.close();
```

The core (`createVectorNest`) takes injected collaborators (store, embedder, loader), so it's
unit-testable without infrastructure — see [`ARCHITECTURE.md`](./ARCHITECTURE.md) §3.

## How it works

- **Functional core / imperative shell.** Pure logic (chunking, ranking/RRF, the activation gate,
  model registry) has no I/O and is unit-tested without mocks. All I/O lives behind injected ports
  (`VectorStore`, `EmbeddingProvider`, `DocumentLoader`, `BranchManager`).
- **Model-versioned embeddings** (`vn_embeddings` keyed by `(chunk_id, model_id)`) are what make a
  zero-downtime swap a single `is_active` flip, with old vectors still serving until you drop them.
- **Branches don't merge data back** — so rehearsal is a re-embed/eval *sandbox*, and the production
  swap relies on the model-versioned table, not a branch merge. This is the correct, safe design.

## Testing

```bash
pnpm --filter vectornest test       # unit suite (hermetic): coverage gates, RRF/eval/chunking 100%
pnpm --filter vectornest test:int   # integration: live Neon + embeddings (skips without creds)
```

The unit suite is hermetic (no network/DB). Integration tests run against a live Neon DB + the
embeddings endpoint and self-skip when credentials are absent; rehearsal tests additionally need the
Neon API creds.

## Limitations & roadmap

- v1 query uses **exact** kNN (correct at low-millions of vectors). Per-model **HNSW** indexes are
  the next step for larger corpora.
- English FTS only (`to_tsvector('english', …)`).
- **HTTP** entrypoint is reserved for v2 (the manifest reserves it); library/CLI/MCP ship today.

## Discoverability & rules

Publishes [`neon-tool.json`](./neon-tool.json) per the collection's
[discovery convention](../TOOLS.md) (glob `**/neon-tool.json`). Inherits the collection's
[`CLAUDE.md`](./CLAUDE.md) (TypeScript-service SSDLC ruleset).
