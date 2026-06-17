# Troubleshooting

## Config / startup

**`ZodError: DATABASE_URL is required` (or `EMBEDDINGS_BASE_URL …`)**
Config is validated at startup. Ensure `vectornest/.env` exists and is filled, or that the vars are
exported. The CLI/MCP/HTTP entrypoints auto-load `.env`; bare `tsx`/imports do not.

**`unknown embedding dimension for "<model>"; set VECTORNEST_EMBED_DIM`**
Your model isn't in the built-in dimension table. Set `VECTORNEST_EMBED_DIM` to its dimension
(see [Configuration](./configuration.md#environment-variables)).

**`VECTORNEST_HTTP_TOKEN is required to run the HTTP server`**
The HTTP server fails closed. Set a token: `VECTORNEST_HTTP_TOKEN=$(openssl rand -hex 32)`.

## Database

**SSL / `sslmode` warnings or connection failures**
TLS is configured explicitly (verify cert + hostname). The `sslmode` in `DATABASE_URL` is honored:
`disable` → no TLS, `no-verify` → encrypt without verification (dev/self-signed only), anything else
→ full verification. Neon's public certs verify fine with the default `sslmode=require`.

**`type "vector" does not exist` / migrations fail**
The `migrate` step runs `CREATE EXTENSION IF NOT EXISTS vector`. Make sure your Neon role can create
extensions (the default owner can). On non-Neon Postgres, install pgvector ≥ 0.5 first.

## Querying

**`different vector dimensions N and M`**
A query embedded with a different-dimension model than the stored vectors. This is handled
internally (queries embed with the *active* model), so if you see it, an inactive/foreign model id
is being queried directly — re-check the active model with `cli models`.

**`no active embedding model; run ingest first`**
Nothing has been ingested yet (the first ingest registers + activates the configured model), or all
models were dropped. Ingest, or `activate` a fully-embedded model.

**Keyword/hybrid returns nothing**
Keyword search uses English full-text (`to_tsvector('english', …)`). Very short corpora or
non-English text may not match; try `--mode vector` or `hybrid`.

## Models & swaps

**`cannot activate "<model>": only X/Y chunks are embedded — re-embed first`**
The safety gate. Run `reembed <model>` until coverage is full (`cli models` shows `coverage`), then
`activate`.

**`model "<model>" is not registered`**
Ingest or re-embed under it first (that registers it), or check the exact name with `cli models`.

**`refusing to drop embeddings for the active model`**
Activate a different model first, then `drop-model` the old one.

## Rehearsal (Neon API)

**`rehearsal requires Neon API credentials (set NEON_API_KEY and NEON_PROJECT_ID)`**
Set both ([Configuration](./configuration.md#neon-api-branch-rehearsal-only)).

**`Neon API … failed: HTTP 404 project not found`**
`NEON_PROJECT_ID` must be the **project id** (e.g. `frosty-lab-41630902`), not the display name.
Find it in Neon Console → Settings → General.

**`org_id is required` when listing projects**
Org-scoped Neon account. Branch operations by project id don't need `org_id`; just set the correct
`NEON_PROJECT_ID`.

## HTTP

**401 on `/v1/*`**
Missing/incorrect `Authorization: Bearer <token>`. The token must match `VECTORNEST_HTTP_TOKEN`.

**400 `application/problem+json`**
Request validation failed; the `detail` field lists the offending fields.

## Still stuck?

Open a discussion/issue (no secrets — see [`../../SECURITY.md`](../../SECURITY.md)). Include the
command, the (redacted) error, and your provider/model.
