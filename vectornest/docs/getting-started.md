# Getting started

This walks you from a clean checkout to ingesting documents and running a semantic query.

## 1. Prerequisites

- **Node ≥ 22** and **pnpm** (`corepack enable pnpm` provisions the pinned version).
- A **Neon** Postgres database — [console.neon.tech](https://console.neon.tech), free tier is fine.
- An **OpenAI-compatible embeddings endpoint**. The default is Cloudflare Workers AI; a fully local,
  keyless option (Ollama) is also supported. Both are set up in [Configuration](./configuration.md).

## 2. Install

```bash
pnpm install
```

## 3. Configure

Copy the template and fill it in (see [Configuration](./configuration.md) for where each value comes
from):

```bash
cp vectornest/.env.example vectornest/.env
```

Minimum to run:

```dotenv
DATABASE_URL=postgresql://USER:PASSWORD@HOST/neondb?sslmode=require
EMBEDDINGS_BASE_URL=https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1
EMBEDDINGS_API_KEY=<cloudflare-token>
VECTORNEST_MODEL=@cf/baai/bge-base-en-v1.5
```

`.env` is git-ignored. The CLI auto-loads it; nothing else to wire.

> **Local, zero-key alternative (Ollama):** `ollama pull nomic-embed-text`, then set
> `EMBEDDINGS_BASE_URL=http://localhost:11434/v1`, `VECTORNEST_MODEL=nomic-embed-text`, and leave
> `EMBEDDINGS_API_KEY` empty.

## 4. Apply the schema

```bash
pnpm --filter vectornest cli migrate
#   migrations applied
```

(`ingest` runs migrations automatically too — this just lets you verify connectivity first.)

## 5. Ingest a corpus

Point it at a folder of `.md`/`.txt` files (the repo ships a tiny sample set):

```bash
pnpm --filter vectornest cli ingest ./vectornest/test/integration/fixtures --collection demo
#   ingested 3 document(s), 3 chunk(s); skipped 0
```

Re-running is idempotent — unchanged files are skipped (by content hash).

## 6. Query

```bash
pnpm --filter vectornest cli query "how does Neon make idle databases free?" --collection demo
#   0.71  .../fixtures/neon.md#0  Neon is serverless Postgres. Its scale-to-zero feature…
```

Try the other modes:

```bash
pnpm --filter vectornest cli query "pgvector HNSW index" --collection demo --mode keyword
pnpm --filter vectornest cli query "vector search in postgres" --collection demo --mode hybrid
```

## 7. What next

- Wire it into your app → [Integration](./integration.md) (library / HTTP / MCP).
- Upgrade the embedding model safely → [Re-embedding & model swaps](./re-embedding.md).
- Hit a snag → [Troubleshooting](./troubleshooting.md).
