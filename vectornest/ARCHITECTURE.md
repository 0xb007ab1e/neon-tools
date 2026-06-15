# VectorNest — v1 Architecture & Scope

_Design sketch (2026-06-15). Status: **scaffold** — directory + design laid down, no implementation
yet. Decisions trace to [`../research/teardown-finalists.md`](../research/teardown-finalists.md)._

## 1. Positioning (what the teardown decided)

VectorNest turns a **Neon Postgres you already run** into a managed RAG vector store, so teams can
**cancel the separate vector-DB subscription** (Pinecone ~$70+/mo, Weaviate ~$135+/mo at ~10M
vectors) **and** delete the relational↔vector dual-write/sync.

- **The value is structural, not a pricing trick:** one DB, one bill, transactional consistency
  between rows and their vectors. (This survives scrutiny; scale-to-zero is a bonus, not the basis.)
- **The real competitor is Supabase / RDS pgvector, not Pinecone** — pgvector is commodity. So
  **VectorNest's moat is the RAG *workflow* + DX, never the vector type.** The two DX bets:
  1. **Safe, branch-rehearsed re-embedding** with zero-downtime model swaps (the signature feature).
  2. A clean ingest→chunk→embed→query→eval loop that's genuinely nicer than wiring pgvector by hand.

## 2. v1 scope

**In (v1):**
- Connect to a Neon branch; idempotently provision pgvector + schema (migrations).
- **Ingest:** documents → chunk (pluggable strategy) → embed (pluggable provider) → store, with
  content-hash idempotency and resumable batches.
- **Query:** kNN semantic search + metadata filters; optional hybrid (vector + Postgres FTS).
- **Re-embed:** model-versioned embeddings + **branch rehearsal** + **atomic active-model swap**
  (zero downtime). The differentiator.
- **Eval (light):** run a query set, report recall@k + latency for a model/config; used to gate a swap.
- Entrypoints: **library + CLI** (core), **MCP server** (for harness/agent discovery).

**Out (deferred / other tools):**
- Multi-tenant control plane, per-tenant routing → **TenantForge (#2)** (VectorNest is the per-DB engine).
- Text-to-SQL / NL analytics → **AskData (#15)**.
- Heavyweight eval/leaderboards → graduates to **EvalBranch (#14)** as its own tool.
- Billion-scale ANN, GPU indexes (pgvector targets low-millions; state the ceiling, don't pretend).
- HTTP service is **stubbed** in v1 (manifest reserves it); ship lib+CLI+MCP first.

## 3. Architecture style (per the SSDLC rules)

**Functional core / imperative shell + ports & adapters.** Pure logic (chunking, ranking, swap
state machine, manifest of models) has no I/O and is unit-testable without mocks; all I/O lives in
injected adapters.

```mermaid
flowchart LR
  subgraph Entrypoints (imperative shell)
    LIB[Library API]:::e
    CLI[CLI]:::e
    MCP[MCP server]:::e
    HTTP[HTTP API - v2]:::p
  end
  subgraph Core (pure)
    CHUNK[chunking]:::c
    RANK[ranking/hybrid merge]:::c
    SWAP[re-embed swap state machine]:::c
    REG[model registry logic]:::c
  end
  subgraph Ports
    EMB[(EmbeddingProvider)]:::port
    STORE[(VectorStore)]:::port
    BRANCH[(BranchManager)]:::port
    LOADER[(DocumentLoader)]:::port
  end
  subgraph Adapters
    GW[AI Gateway / OpenAI]:::a
    PG[Neon pg + pgvector]:::a
    NEONAPI[Neon API branches]:::a
    FILES[fs/url/markdown loaders]:::a
  end
  LIB & CLI & MCP --> Core
  Core --> EMB & STORE & BRANCH & LOADER
  EMB --> GW
  STORE --> PG
  BRANCH --> NEONAPI
  LOADER --> FILES
  classDef e fill:#def;classDef p fill:#eee,stroke-dasharray:3;classDef c fill:#efe;classDef port fill:#ffe;classDef a fill:#fed;
```

**Ports (interfaces the core owns):** `EmbeddingProvider` (embed text → vectors, declares `dim`),
`VectorStore` (upsert/query/migrate), `BranchManager` (create/delete Neon branch via API),
`DocumentLoader` (bytes → documents). Adapters are injected at a composition root per entrypoint.

## 4. Data model (Postgres)

Embeddings live in their **own table keyed by model** — this is what makes zero-downtime re-embed
possible (old + new model vectors coexist; the "swap" is a metadata flip).

| Table | Key columns |
|---|---|
| `vn_collections` | `id`, `name` (logical namespace; becomes per-tenant scope later) |
| `vn_documents` | `id`, `collection_id`, `source_uri`, `content_hash` (idempotency), `metadata jsonb`, timestamps |
| `vn_chunks` | `id`, `document_id`, `ordinal`, `text`, `token_count`, `metadata jsonb` |
| `vn_embedding_models` | `id`, `name` (e.g. `openai/text-embedding-3-small`), `dim`, `provider`, `is_active` |
| `vn_embeddings` | `chunk_id`, `model_id`, `embedding vector(dim)`, timestamp — PK `(chunk_id, model_id)` |

- **Index:** HNSW per active model on `vn_embeddings.embedding` (IVFFlat fallback). One partial/sub
  index per model dimension.
- Constraints in the DB (FKs, NOT NULL, UNIQUE content_hash per collection) — don't rely on app code.
- Queries are **always parameterized**; `vector` literals bound, never string-built.

## 5. Key flows

**Ingest** — `loader → core.chunk → provider.embed (active model, batched) → store.upsert`. Skip
unchanged docs by `content_hash`. Resumable: re-running continues where it stopped.

**Query** — embed the query with the **active** model → kNN against that model's index → optional
hybrid merge with Postgres FTS (`tsvector`) in the pure ranker → return chunks + scores + source refs.

**Re-embed with zero-downtime swap (the differentiator):**
1. `vectornest reembed --model openai/text-embedding-3-large`
2. **Rehearse on a branch:** `BranchManager` creates a Neon branch (copy-on-write, cheap); re-embed
   the corpus there into the new model's rows; run **eval** (recall@k, latency) to estimate
   quality/cost/time — all without touching production.
3. **If it passes:** run the same idempotent re-embed against production (new model rows added
   *alongside* the live active model — old model keeps serving, no downtime).
4. **Swap:** flip `is_active` to the new model in one transaction. Queries instantly target it.
   Roll back = flip back. Drop the old model's rows later.

> Honest note: Neon branches don't auto-merge data back, so the branch is a **rehearsal + eval
> sandbox**, and the production swap relies on the **model-versioned table**, not a branch merge.
> This is the correct, safe design — and it's exactly the DX a hand-rolled pgvector setup lacks.

**Eval** — given a labeled query set, compute recall@k / MRR / latency for a model+config; output a
report and a pass/fail against a threshold. Gates step 3 of re-embed. (Grows into EvalBranch #14.)

## 6. Discoverability (harness/agent integration)

- Publishes [`neon-tool.json`](./neon-tool.json) → found by globbing `**/neon-tool.json`.
- **MCP server** is a first-class v1 entrypoint: exposes `vn_ingest`, `vn_query`, `vn_reembed`,
  `vn_eval`, `vn_collections` over stdio so an agent/harness can discover and call VectorNest at
  runtime (this is also a Neon-native pattern — agents provisioning/using databases via MCP).
- `provides` capability tokens (`rag.ingest`, `rag.query`, …) let TenantForge or a SaaS shell wire
  VectorNest in without bespoke glue.

## 7. Security & SSDLC compliance

- **Secrets** (`DATABASE_URL`, `NEON_API_KEY`, `AI_GATEWAY_API_KEY`) from env only; `.env` git-ignored,
  `.env.example` committed. Least-privilege DB role (DML on `vn_*`, no superuser).
- **Validate all inputs** at boundaries (zod): document size caps, chunk limits, query length, k bounds
  (DoS / cost control). Treat embedding-provider responses as untrusted.
- **No raw SQL string-building** — parameterized everywhere (CWE-89). No `eval`/dynamic code.
- **Redact** secrets/PII from logs; structured logs with a correlation id.
- **Cost guardrails:** cap embedding batch size, max docs/query, per-run token budget (LLM04 cost-DoS).
- Tests + coverage gates per master §4 (pgvector logic = critical path; aim high). pgvector queries
  get integration tests against a real Neon branch (ephemeral, per CI run).

## 8. Tech stack

- **Node LTS + TypeScript (strict, ESM).** `pg` (node-postgres) or `postgres.js`; `zod` validation.
- **Embeddings via Vercel AI Gateway** using `provider/model` strings (default, pluggable per the
  `EmbeddingProvider` port) — e.g. `openai/text-embedding-3-small`.
- CLI: lightweight (e.g. `citty`/`commander`). MCP: `@modelcontextprotocol/sdk`. Tests: `vitest` +
  Neon-branch-backed integration. Migrations: plain SQL files, forward-only + reversible where feasible.

## 9. Proposed source tree

```
vectornest/
  neon-tool.json          # discovery manifest
  README.md  ARCHITECTURE.md  CLAUDE.md  .env.example
  package.json  tsconfig.json
  migrations/             # 0001_init.sql ...
  src/
    core/                 # pure: chunking, ranking, swap-state-machine, model-registry
    ports/                # EmbeddingProvider, VectorStore, BranchManager, DocumentLoader
    adapters/             # ai-gateway/, neon-pg/, neon-api/, loaders/
    app/                  # composition roots: lib.ts, cli.ts, mcp.ts (http.ts later)
  test/                   # unit (core) + integration (Neon branch)
  openapi.yaml            # reserved for the v2 HTTP entrypoint
```

## 10. Milestones

- **Week 1 (walking skeleton):** schema + migrations; `VectorStore` (Neon pg) + `EmbeddingProvider`
  (AI Gateway) adapters; `ingest` + `query` via **library + CLI**; unit tests on the pure core;
  one integration test against a Neon branch. → can ingest a folder and semantically query it.
- **Month 1 (the differentiators):** branch-rehearsed **re-embed** + zero-downtime active-model swap;
  **eval** command + swap gate; **MCP server** entrypoint; hybrid (vector+FTS) query; cost guardrails;
  coverage gates green; `README` quickstart + TSDoc. → the demoable "consolidate + safely re-embed" story.

## 11. How it grows into the SaaS

VectorNest is the **per-database RAG engine**. The SaaS path: **TenantForge (#2)** provisions a Neon
project per customer and embeds VectorNest as each tenant's isolated vector store (one Postgres =
relational + vectors + auth). **EvalBranch (#14)** and a branch-based re-embed service can graduate
out of VectorNest's `core/` into their own tool dirs, reusing the same `BranchManager` port. Each
stays standalone and discoverable; the SaaS is their composition.
