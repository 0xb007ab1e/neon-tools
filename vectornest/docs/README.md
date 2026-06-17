# VectorNest documentation

Start here, then dive into the guide you need.

| Guide | What it covers |
|---|---|
| [Getting started](./getting-started.md) | Install → configure → first ingest + query, end to end. |
| [Configuration](./configuration.md) | Every environment variable, and step-by-step setup for Neon and each embeddings provider (Cloudflare / Ollama / Gemini). |
| [CLI reference](./cli-reference.md) | Every command and flag, with examples and output. |
| [Integration](./integration.md) | Use VectorNest from your project — as a **library**, over **HTTP**, or via **MCP**. |
| [Re-embedding & model swaps](./re-embedding.md) | The signature workflow: rehearse → eval → gate → zero-downtime swap → rollback. |
| [Troubleshooting](./troubleshooting.md) | Common errors and fixes. |

API reference (generated from source TSDoc): `pnpm --filter vectornest run docs` → `docs/api/`.

See also the top-level [README](../README.md) (overview) and [ARCHITECTURE](../ARCHITECTURE.md) (design).
