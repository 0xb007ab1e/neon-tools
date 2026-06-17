# Tool Registry

Human-readable index of the standalone tools in this collection. Each tool lives in its **own
subdirectory** under the collection root and publishes a machine-readable
[`neon-tool.json`](./tool-manifest.schema.json) manifest at its directory root.

## Discovery convention (how harnesses/agents find these tools)

1. **Static discovery** — glob `**/neon-tool.json` from the collection root; each match is a tool.
   Parse against [`tool-manifest.schema.json`](./tool-manifest.schema.json).
2. **Runtime invocation** — read the manifest's `entrypoints`:
   - `library` → import the package.
   - `cli` → run the command.
   - `http` → call the service (OpenAPI spec path given).
   - `mcp` → launch/connect the MCP server; its `tools[]` list the callable operations.
3. **Composition** — `provides` / `consumes` capability tokens (e.g. `rag.query`) and `dependsOn`
   describe how tools wire together into a larger SaaS.

> A future `pnpm discover` script can aggregate all manifests into a generated `tools.lock.json`;
> until then, globbing the manifests **is** the registry. This file is the human mirror — keep it
> in sync when adding a tool (one row per tool).

## Tools

| Tool | Dir | Status | Category | Summary | Provides |
|---|---|---|---|---|---|
| **VectorNest** | [`vectornest/`](./vectornest/) | beta | ai | Consolidate a separate vector DB into the Neon Postgres you already run — RAG ingest/query, three retrieval modes, and safe branch-rehearsed zero-downtime re-embedding. | `rag.ingest`, `rag.query`, `rag.reembed`, `rag.eval` |
| **TenantForge** | [`tenantforge/`](./tenantforge/) | alpha | infra | Control plane for database-per-tenant SaaS on Neon — provision an isolated project per customer, route connections, orchestrate fleet migrations, and manage tenant lifecycle. | `tenant.provision`, `tenant.route`, `tenant.lifecycle`, `tenant.migrate` |

_(Add a row per new tool. Ideas not yet built live in [`research/product-concepts.md`](./research/product-concepts.md).)_
