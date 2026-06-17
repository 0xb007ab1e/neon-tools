# CLI reference

Run as `pnpm --filter vectornest cli <command> [args]` (auto-loads `.env`), or as the `vectornest`
binary after `pnpm --filter vectornest build`. `--help` works on the root and every subcommand.

```text
vectornest migrate|ingest|query|reembed|rehearse|eval|activate|models|drop-model
```

## migrate

Apply pending schema migrations (idempotent). `ingest`/`reembed` run this automatically.

```bash
pnpm --filter vectornest cli migrate
#   migrations applied
```

## ingest `<source>` `[--collection]`

Ingest a file or directory (`.md`, `.markdown`, `.txt`, `.text`) into a collection. Idempotent:
unchanged documents (by content hash) are skipped. Resumable.

| Flag | Default | Description |
|---|---|---|
| `--collection` | `default` | Target collection. |

```bash
pnpm --filter vectornest cli ingest ./docs --collection handbook
#   ingested 12 document(s), 84 chunk(s); skipped 0
```

## query `<text>` `[--collection] [--k] [--mode]`

Search a collection.

| Flag | Default | Description |
|---|---|---|
| `--collection` | `default` | Collection to search. |
| `--k` | `5` | Number of results (1–100). |
| `--mode` | `vector` | `vector` (pgvector kNN), `keyword` (Postgres FTS), or `hybrid` (RRF of both). |

```bash
pnpm --filter vectornest cli query "how do refunds work?" --collection handbook --mode hybrid --k 3
#   0.84  ./docs/billing/refunds.md#2  Refunds are issued to the original payment method…
```

## reembed `<model>` `[--dim] [--activate] [--rehearse] [--eval] [--recall] [--mrr]`

Re-embed the corpus under a model, **alongside** the active one (no downtime). See
[Re-embedding & model swaps](./re-embedding.md).

| Flag | Default | Description |
|---|---|---|
| `--dim` | known | Dimension, if the model isn't in the known table. |
| `--activate` | `false` | Activate once fully embedded (zero-downtime swap). |
| `--rehearse` | `false` | Rehearse on a throwaway Neon branch first; abort if it doesn't pass. |
| `--eval <file>` | — | Eval set to run on the rehearsal branch; gates the swap (implies rehearse). |
| `--recall` / `--mrr` | — | Minimum recall@k / MRR for the eval gate. |

```bash
pnpm --filter vectornest cli reembed @cf/baai/bge-large-en-v1.5 \
  --rehearse --eval ./eval.json --recall 1.0 --activate
#   re-embedded 84 chunk(s); coverage 84/84; ACTIVATED
```

## rehearse `<model>` `[--dim]`

Re-embed + report on a throwaway Neon branch, leaving production untouched. Requires Neon API creds.

```bash
pnpm --filter vectornest cli rehearse @cf/baai/bge-large-en-v1.5
#   rehearsed @cf/baai/bge-large-en-v1.5 on branch br-… : 84/84 embedded in 9100ms — PASS
```

## eval `<model>` `<set.json>` `[--k] [--recall] [--mrr]`

Evaluate retrieval quality against a labeled query set. **Exits non-zero** if below thresholds (use
it as a CI/script gate).

An eval set is JSON: `[{ "query": "…", "relevant": ["source-uri-substring"] }]`.

```bash
pnpm --filter vectornest cli eval @cf/baai/bge-base-en-v1.5 ./eval.json --k 5 --recall 0.9
#   eval @cf/baai/bge-base-en-v1.5: recall@5=1.000 mrr=1.000 over 12 case(s) in 480ms — PASS
```

## activate `<model>`

Make a fully-embedded model active (the swap; also used to roll back). Refuses partially-embedded
models.

```bash
pnpm --filter vectornest cli activate @cf/baai/bge-base-en-v1.5
#   active model is now @cf/baai/bge-base-en-v1.5
```

## models

List registered models with coverage (`*` marks the active one).

```bash
pnpm --filter vectornest cli models
#   * @cf/baai/bge-base-en-v1.5   dim=768   coverage=84/84
#     @cf/baai/bge-large-en-v1.5  dim=1024  coverage=84/84
```

## drop-model `<model>`

Delete a non-active model's embeddings (and its HNSW index) to reclaim space. Refuses the active model.

```bash
pnpm --filter vectornest cli drop-model @cf/baai/bge-large-en-v1.5
#   dropped 84 embedding row(s) for @cf/baai/bge-large-en-v1.5
```
