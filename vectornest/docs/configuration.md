# Configuration

All configuration comes from the environment (12-Factor). For local use, put it in a git-ignored
`vectornest/.env` (copy [`.env.example`](../.env.example)); the CLI, MCP, and HTTP entrypoints
auto-load it. Config is validated at startup — the process fails fast on anything missing or invalid.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | ✅ | — | Neon Postgres connection string. |
| `EMBEDDINGS_BASE_URL` | ✅ | — | OpenAI-compatible embeddings base URL, **including `/v1`**. |
| `EMBEDDINGS_API_KEY` | hosted only | — | Bearer token for the endpoint. Omit for keyless local servers (Ollama). |
| `VECTORNEST_MODEL` | – | `@cf/baai/bge-base-en-v1.5` | Provider/model string for embeddings. |
| `VECTORNEST_EMBED_DIM` | only if model unknown | derived | Embedding dimension. Resolved automatically for known models (see below); set it for any other model. |
| `VECTORNEST_EMBED_BATCH_SIZE` | – | `64` | Max texts per embedding request (cost/throughput control). |
| `NEON_API_KEY` | rehearsal only | — | Neon API key — enables branch rehearsal. |
| `NEON_PROJECT_ID` | rehearsal only | — | Neon **project id** (not the project name). |
| `NEON_API_BASE_URL` | – | `https://console.neon.tech/api/v2` | Override for self-hosted/enterprise Neon. |
| `VECTORNEST_HTTP_TOKEN` | HTTP only | — | Bearer token required to run the HTTP server (fail-closed). |
| `VECTORNEST_PORT` | – | `3000` | HTTP server port. |

**Known model dimensions** (no `VECTORNEST_EMBED_DIM` needed): `@cf/baai/bge-small-en-v1.5` (384),
`@cf/baai/bge-base-en-v1.5` (768), `@cf/baai/bge-large-en-v1.5` (1024), `openai/text-embedding-3-small`
(1536), `openai/text-embedding-3-large` (3072), `openai/text-embedding-ada-002` (1536),
`nomic-embed-text` (768), `mxbai-embed-large` (1024), `all-minilm` (384). For anything else, set
`VECTORNEST_EMBED_DIM`.

## Neon (`DATABASE_URL`)

1. [console.neon.tech](https://console.neon.tech) → create a project (free tier is fine).
2. From the project dashboard, copy the **connection string** (a dev branch's string is ideal for
   experiments). It looks like `postgresql://user:password@ep-xxx.region.aws.neon.tech/neondb?sslmode=require`.
3. pgvector and full-text search are set up automatically by VectorNest's migrations — nothing to install.
4. *(Optional, recommended)* use a least-privilege role rather than the owner; grant it DML on the
   `vn_*` tables after the first `migrate`.

TLS is configured explicitly (verify cert + hostname); `sslmode` in the URL is honored
(`disable`/`no-verify` opt-outs respected) — see [Troubleshooting](./troubleshooting.md).

## Embeddings provider

VectorNest talks to any **OpenAI-compatible** `/embeddings` endpoint. Pick one:

### Cloudflare Workers AI (default, hosted, free tier)

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → copy your **Account ID**.
2. **My Profile → API Tokens → Create Token** → *Workers AI* template (or a token with
   Account → Workers AI → Read).
3. Set:
   ```dotenv
   EMBEDDINGS_BASE_URL=https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1
   EMBEDDINGS_API_KEY=<token>
   VECTORNEST_MODEL=@cf/baai/bge-base-en-v1.5
   ```

### Ollama (local, keyless)

```bash
ollama pull nomic-embed-text
```
```dotenv
EMBEDDINGS_BASE_URL=http://localhost:11434/v1
VECTORNEST_MODEL=nomic-embed-text
# EMBEDDINGS_API_KEY left empty
```

### Google Gemini (hosted, free tier)

Get an AI Studio key, then:
```dotenv
EMBEDDINGS_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
EMBEDDINGS_API_KEY=<gemini-key>
VECTORNEST_MODEL=text-embedding-004
VECTORNEST_EMBED_DIM=768
```

## Neon API (branch rehearsal only)

Rehearsing a model on a throwaway branch needs the Neon **API**:

- `NEON_API_KEY`: Neon Console → **Account settings → API keys → Create**.
- `NEON_PROJECT_ID`: the project's **system id** (Settings → General → *Project ID*, e.g.
  `frosty-lab-41630902`) — **not** the display name. If your account is organization-scoped, the
  project still lives under an org but branch operations use this project id directly.

Without these, `rehearse` and `reembed --rehearse` are unavailable (everything else works).

## HTTP server

`VECTORNEST_HTTP_TOKEN` is **required** to start the HTTP server — it refuses to boot without one
(fail-closed). Every `/v1/*` request must send `Authorization: Bearer <token>`. See
[Integration → HTTP](./integration.md#http-api).
