# VectorNest — project rules

> Inherits the master SSDLC ruleset (~/.claude/CLAUDE.md) automatically.
> Standalone tool in the Neon collection; see ../TOOLS.md for the discovery convention.

## Applied rule modules
@~/.claude/rules/lang-typescript.md
@~/.claude/rules/std-owasp-llm.md          # RAG/embeddings: untrusted output, cost-DoS, injection
@~/.claude/rules/std-owasp-proactive.md
@~/.claude/rules/std-cwe.md
@~/.claude/rules/topic-token-optimization.md  # embedding cost at scale
@~/.claude/rules/topic-database.md         # pgvector schema, migrations, indexes
@~/.claude/rules/topic-api-consumption.md  # embedding provider is an untrusted upstream
@~/.claude/rules/std-supplychain.md
@~/.claude/rules/workflow-cicd.md
@~/.claude/rules/topic-testing.md
@~/.claude/rules/topic-architecture-patterns.md  # functional core / ports & adapters
@~/.claude/rules/topic-dependency-injection.md
# @~/.claude/rules/std-privacy.md          # enable if ingested corpora contain personal data

## Stack
- Runtime: Node LTS; TypeScript strict; ESM.
- Data: Neon Postgres + pgvector; query layer: `pg` (or `postgres.js`); validation: `zod`.
- Embeddings: OpenAI-compatible endpoint (default Cloudflare Workers AI `@cf/baai/bge-base-en-v1.5`), behind an `EmbeddingProvider` port; provider-agnostic (Ollama/Gemini/etc. via env).
- Entrypoints: library, CLI, MCP server (`@modelcontextprotocol/sdk`); HTTP reserved for v2.

## Project-specific rules
- **Data classification:** ingested content may be confidential/PII depending on the corpus —
  classify per deployment; redact from logs; no real personal data in tests.
- **Moat is the workflow, not pgvector:** invest in re-embed-on-branch DX + eval, not the vector type.
- **Always parameterize** SQL incl. `vector` literals; validate doc/chunk/query/k bounds (cost-DoS).
- **Branches don't merge data back** — re-embed rehearses on a branch; the prod swap is a
  model-versioned-table active-flag flip (see ARCHITECTURE §5). Keep that invariant.
- Treat embedding-provider responses as untrusted; cap batch size + per-run token budget.
- Secrets from env only (`.env` git-ignored, `.env.example` committed).
- Keep the pure `core/` free of I/O so it's unit-testable without mocks; pgvector logic is a
  critical path — integration-test it against an ephemeral Neon branch in CI.
