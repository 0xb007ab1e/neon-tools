# Integration

Three ways to use VectorNest from your project: as a **library**, over **HTTP**, or via **MCP**.
(Ingestion and re-embedding are operator tasks — do them with the [CLI](./cli-reference.md) or MCP,
then query from your app.)

## Library (TypeScript/Node)

Install the package (within this workspace it's `@neon-tools/vectornest`) and drive the service
directly. The package entry exports the service, the config loader, and the result types.

```ts
import { vectorNestFromConfig, loadConfig, type QueryHit } from '@neon-tools/vectornest';

const vn = vectorNestFromConfig(loadConfig()); // reads DATABASE_URL, EMBEDDINGS_* from env
try {
  await vn.migrate();
  await vn.ingest('./docs', { collection: 'handbook' });

  const hits: QueryHit[] = await vn.query('how do refunds work?', {
    collection: 'handbook',
    mode: 'hybrid',
    k: 5,
  });
  for (const hit of hits) {
    console.log(hit.score.toFixed(3), hit.sourceUri, hit.text.slice(0, 80));
  }
} finally {
  await vn.close(); // release the connection pool
}
```

Building config yourself (instead of `loadConfig`):

```ts
import { vectorNestFromConfig, type Config } from '@neon-tools/vectornest';

const config: Config = {
  databaseUrl: process.env.DATABASE_URL!,
  embeddingsBaseUrl: process.env.EMBEDDINGS_BASE_URL!,
  embeddingsApiKey: process.env.EMBEDDINGS_API_KEY,
  model: '@cf/baai/bge-base-en-v1.5',
  dim: 768,
  embedBatchSize: 64,
  port: 3000,
};
const vn = vectorNestFromConfig(config);
```

For unit tests, build the service from fakes with `createVectorNest({ store, embedder, loader,
createEmbedder, embedBatchSize })` — the core takes injected collaborators, so no DB/network is
needed. The full API surface (methods, options, result types) is in the generated API reference
(`pnpm --filter vectornest run docs`).

## HTTP API

Run the server (fails closed without a token):

```bash
VECTORNEST_HTTP_TOKEN=$(openssl rand -hex 32) pnpm --filter vectornest http
#   vectornest http listening on :3000
```

Every `/v1/*` request needs `Authorization: Bearer <token>`. Errors use RFC 9457
`application/problem+json`. Full contract: [`openapi.yaml`](../openapi.yaml).

```bash
# health (no auth)
curl -s localhost:3000/health
#   {"status":"ok","tool":"vectornest","version":"0.0.0"}

# query
curl -s localhost:3000/v1/query \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"how do refunds work?","collection":"handbook","mode":"hybrid","k":3}'
#   {"hits":[{"chunkId":"…","sourceUri":"./docs/billing/refunds.md","score":0.84,...}]}

# list collections / models
curl -s localhost:3000/v1/collections -H "authorization: Bearer $TOKEN"
curl -s localhost:3000/v1/models       -H "authorization: Bearer $TOKEN"

# activate a model (zero-downtime swap)
curl -s -X POST localhost:3000/v1/models/@cf%2Fbaai%2Fbge-large-en-v1.5/activate \
  -H "authorization: Bearer $TOKEN"
```

A typed client from your app:

```ts
async function query(text: string) {
  const res = await fetch(`${process.env.VECTORNEST_BASE_URL}/v1/query`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.VECTORNEST_HTTP_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ text, mode: 'hybrid', k: 5 }),
  });
  if (!res.ok) throw new Error(`vectornest ${res.status}: ${await res.text()}`);
  return (await res.json()).hits;
}
```

> The HTTP surface is read + light management (`query`, `collections`, `models`, `activate`, `eval`).
> It deliberately omits `ingest`/`reembed` (server-path-based / long-running) — run those via CLI/MCP.

## MCP (agents & harnesses)

VectorNest is an MCP server over stdio, so agent frameworks can discover and call it.

```jsonc
{
  "mcpServers": {
    "vectornest": {
      "command": "pnpm",
      "args": ["--filter", "vectornest", "mcp"]
    }
  }
}
```

Tools exposed: `vn_ingest`, `vn_query` (supports `mode`), `vn_reembed`, `vn_eval`, `vn_collections`.
The server reads the same `.env` configuration. Harnesses can also auto-discover the tool by globbing
`**/neon-tool.json` (see [`../neon-tool.json`](../neon-tool.json) and [`../../TOOLS.md`](../../TOOLS.md)).
