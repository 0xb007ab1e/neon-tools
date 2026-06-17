# Re-embedding & zero-downtime model swaps

VectorNest's signature capability: change the embedding model for an existing corpus **safely** —
validated before it touches production, switched atomically, reversible instantly.

## Why it's safe

Embeddings are stored keyed by `(chunk_id, model_id)`, so **many models' vectors coexist**. The
"active" model is a single flag. That makes the lifecycle:

1. **Re-embed** the corpus under the new model into *new* rows — the old model keeps serving queries
   the whole time (no downtime).
2. **Swap** by flipping `is_active` in one transaction — queries instantly use the new model.
3. **Roll back** by flipping back — the old vectors were never removed.
4. **Drop** the retired model's rows when you're confident.

A safety gate (`assertActivatable`) refuses to activate a model that isn't fully embedded, so you
can never swap to a model that would return partial/missing results.

## The full flow

### 1. Rehearse on a throwaway branch (optional, recommended)

Validate on a cheap copy-on-write Neon branch first — production is never touched. Requires
`NEON_API_KEY` + `NEON_PROJECT_ID` ([Configuration](./configuration.md#neon-api-branch-rehearsal-only)).

```bash
pnpm --filter vectornest cli rehearse @cf/baai/bge-large-en-v1.5
#   rehearsed @cf/baai/bge-large-en-v1.5 on branch br-… : 84/84 embedded in 9100ms — PASS
```

This creates a branch, re-embeds the corpus there, reports coverage + time, and **deletes the
branch**. (Branches don't merge data back, so rehearsal is a sandbox — the production re-embed in
step 2 is separate. This is intentional and correct.)

### 2. Re-embed in production (gated)

Embed alongside the live model. Gate it on a rehearsal that must reach full coverage **and** a
quality bar (recall@k / MRR) before any production change:

```bash
pnpm --filter vectornest cli reembed @cf/baai/bge-large-en-v1.5 \
  --rehearse --eval ./eval.json --recall 1.0
#   re-embedded 84 chunk(s); coverage 84/84; not activated
```

If the rehearsal's eval is below threshold, it aborts before re-embedding production.

### 3. Swap

Activate once fully embedded — instant, zero-downtime:

```bash
pnpm --filter vectornest cli activate @cf/baai/bge-large-en-v1.5
#   active model is now @cf/baai/bge-large-en-v1.5
```

(Or do steps 2–3 in one go with `reembed … --activate`.)

### 4. Verify, then roll back if needed

```bash
pnpm --filter vectornest cli models
#   * @cf/baai/bge-large-en-v1.5  dim=1024  coverage=84/84
#     @cf/baai/bge-base-en-v1.5   dim=768   coverage=84/84

# instant rollback — old vectors are still there
pnpm --filter vectornest cli activate @cf/baai/bge-base-en-v1.5
```

### 5. Clean up

```bash
pnpm --filter vectornest cli drop-model @cf/baai/bge-large-en-v1.5
```

## Evaluation

Score retrieval quality against a labeled query set (`recall@k`, `MRR`) — standalone, or as the swap
gate above. An eval set is JSON:

```json
[
  { "query": "How does refund timing work?", "relevant": ["billing/refunds.md"] },
  { "query": "How do I dispute a charge?",    "relevant": ["billing/disputes.md"] }
]
```

`relevant` entries are matched as substrings of a hit's source URI. A query "hits" if a relevant
document appears in the top-`k`.

```bash
pnpm --filter vectornest cli eval @cf/baai/bge-base-en-v1.5 ./eval.json --k 5 --recall 0.9
```

Because `eval` queries a model's *own* embeddings, you can evaluate a **candidate** model (after
re-embedding under it, before activating) to make a data-driven swap decision.

## Indexes

Each model gets its own HNSW (approximate nearest-neighbor) index, built after re-embed/ingest and
dropped with the model. On small corpora exact search is used (and is correct); HNSW engages at
scale. No action needed.
