# Shortlist Scoring Pass — converging 30 ideas

_2026-06-15. Scores all 30 concepts from [`product-concepts.md`](./product-concepts.md) on a
weighted rubric, then converges to finalists. Scores are reasoned judgment (1–5), not measured —
treat as a structured opinion to argue with, not gospel._

## Rubric

| Criterion | Weight | 5 = | 1 = |
|---|---|---|---|
| **F — Fee/overhead elimination** | 25% | kills a large recurring bill or major eng cost | marginal saving |
| **N — Neon consumption / program fit** | 20% | drives huge project/branch/CU usage, on Neon's narrative | light usage |
| **D — Market demand / pull** | 20% | urgent, proven, broad need | speculative |
| **B — Buildability (low effort/risk)** | 20% | small team ships v1 fast, low risk | long/risky/regulated |
| **M — Moat / defensibility** | 15% | durable (hard problem, data, network) | trivially cloned / Neon ships it |

Weighted total = .25F + .20N + .20D + .20B + .15M (out of 5).

> Note on **F vs N**: the user's stated objective is fee/overhead elimination (F, highest weight);
> the program goal adds N. These can pull apart — e.g. NullCost DR is huge on F, modest on N.

## Full scored table (ranked)

| Rank | # | Idea | F | N | D | B | M | **Total** |
|---|---|---|---|---|---|---|---|---|
| 1 | 1 | AgentBox (agent DB sandboxes) | 4 | 5 | 4 | 4 | 2 | **3.90** |
| 1 | 22 | NullCost DR (free warm standby) | 5 | 3 | 5 | 3 | 3 | **3.90** |
| 3 | 2 | TenantForge (DB-per-tenant BaaS) | 4 | 5 | 4 | 3 | 3 | **3.85** |
| 4 | 7 | ServerlessShift (RDS→Neon FinOps) | 5 | 4 | 4 | 2 | 3 | **3.70** |
| 5 | 23 | DataPort (DB-as-a-deliverable) | 4 | 5 | 3 | 2 | 4 | **3.60** |
| 6 | 3 | VectorNest (pgvector RAG backend) | 4 | 3 | 4 | 4 | 2 | **3.50** |
| 7 | 6 | MaskBranch (PII masking for branches) | 4 | 3 | 4 | 3 | 3 | **3.45** |
| 7 | 10 | MigrateGuard (migration CI gate) | 4 | 3 | 4 | 3 | 3 | **3.45** |
| 7 | 17 | ErasureEngine (GDPR erasure per tenant) | 4 | 3 | 4 | 3 | 3 | **3.45** |
| 7 | 19 | NeonLens (Neon cost observability) | 4 | 3 | 4 | 3 | 3 | **3.45** |
| 11 | 9 | LiteSync (per-user local-first backend) | 4 | 4 | 3 | 2 | 4 | **3.40** |
| 11 | 13 | MemoryVault (branchable agent memory) | 3 | 4 | 4 | 3 | 3 | **3.40** |
| 11 | 15 | AskData (text-to-SQL over Data API) | 3 | 4 | 4 | 3 | 3 | **3.40** |
| 11 | 25 | DecoyDB (honeypot fleet) | 3 | 4 | 3 | 4 | 3 | **3.40** |
| 15 | 12 | FixtureForge (test-data-as-code) | 3 | 4 | 3 | 4 | 2 | **3.25** |
| 16 | 5 | Rewind (production time machine) | 3 | 3 | 3 | 4 | 3 | **3.20** |
| 16 | 18 | AuditVault (per-tenant audit store) | 3 | 3 | 3 | 4 | 3 | **3.20** |
| 16 | 28 | RealClone (disposable prod twin) | 3 | 3 | 3 | 4 | 3 | **3.20** |
| 16 | 29 | RewindMe (user-facing time travel) | 3 | 3 | 4 | 3 | 3 | **3.20** |
| 20 | 27 | ObjectDB (database-per-entity) | 3 | 5 | 2 | 2 | 4 | **3.15** |
| 21 | 4 | PreviewDB (ephemeral preview envs) | 3 | 3 | 4 | 3 | 2 | **3.05** |
| 21 | 8 | DemoLoop (reset-able demo envs) | 3 | 3 | 3 | 4 | 2 | **3.05** |
| 21 | 20 | BranchReaper (orphan GC) | 3 | 2 | 3 | 5 | 2 | **3.05** |
| 24 | 11 | SchemaDiff/DataDiff | 3 | 3 | 3 | 3 | 3 | **3.00** |
| 24 | 14 | EvalBranch (reproducible evals) | 2 | 3 | 4 | 4 | 2 | **3.00** |
| 24 | 24 | ForkLedger (notarized snapshots) | 3 | 3 | 3 | 3 | 3 | **3.00** |
| 24 | 26 | LiveShare Data (shareable live datasets) | 3 | 3 | 3 | 3 | 3 | **3.00** |
| 28 | 16 | ResidencyRouter | 3 | 3 | 3 | 3 | 2 | **2.85** |
| 29 | 30 | CleanRoom (zero-residue joint compute) | 3 | 3 | 3 | 2 | 3 | **2.80** |
| 30 | 21 | TimeFork (counterfactual DB) | 2 | 3 | 2 | 2 | 4 | **2.50** |

## Sensitivity — the scores are close; the weighting changes the winner

The top ~12 sit within **3.40–3.90** — a narrow band. So the *lens* matters more than the raw total:

- **Lens 1 — "Maximize the credits program" (re-weight N + on-narrative up):** AgentBox (#1),
  TenantForge (#2), ObjectDB (#27), DataPort (#23) rise. These drive the most Neon consumption.
- **Lens 2 — "Ship something useful fast / bootstrapped" (re-weight B up, N down):** VectorNest (#3),
  NullCost DR (#22), DecoyDB (#25), Rewind (#5), BranchReaper (#20), FixtureForge (#12) rise.
- **Lens 3 — "Biggest, clearest fee kill" (F only):** ServerlessShift (#7), NullCost DR (#22),
  then the #2/#3/#6/#9/#17 tier.
- **Lens 4 — "Durable platform with the longest roadmap":** TenantForge (#2) — it's the anchor that
  makes #15, #16, #17, #18, #29 *easy*, so one build unlocks a cluster.

## Finalists (the convergence)

Six survive across lenses. Strategic read on each:

1. **TenantForge (#2) — the platform pick.** Near-top score on every lens; anchors Cluster C and makes
   five other ideas trivial. Highest *durable* value + strong consumption. Cost: M–L effort, must out-DX
   "roll your own." **Best if you want one ambitious product with a long roadmap.**
2. **AgentBox (#1) — the program pick.** Highest program fit + market heat. Cost: **moat risk** (Neon
   could ship a first-party version) — must win on framework integrations + DX. **Best if the credits
   program / AI market is the priority.**
3. **NullCost DR (#22) — the broad-demand pick.** Biggest, clearest fee kill with the widest audience
   (nearly every prod DB "should" have DR and skips it on cost). Standalone, buildable in ~weeks. Cost:
   lower Neon CU consumption (storage-heavy) → softer program fit. **Best if you want immediate, broad
   real-world pull.**
4. **VectorNest (#3) — the fast-wedge pick.** Easiest "cancel your Pinecone bill" pitch; ships fast.
   Cost: commodity (pgvector) + Supabase overlap → thin moat. **Best as a quick validation/wedge.**
5. **ServerlessShift (#7) — the lead-gen pick.** Largest raw fee kill (RDS waste) and a free analyzer is
   easy. Cost: trustworthy *migration* is risky/services-heavy. **Best as a top-of-funnel tool, not a platform.**
6. **DataPort (#23) — the high-risk/high-reward pick.** If the provisioning broker is solved, it's a
   platform with real moat + enormous consumption. Cost: L effort, hard abuse/billing problem. **A bet,
   not a starter.**

## Recommendation

**The unresolved variable that should pick the winner is the goal itself** — which the eligibility
reality (see `neon-research.md` §6) sharpens:

- **If the $100K program is genuinely reachable** (a VC-backed entity exists) → lead with **TenantForge (#2)**
  or **AgentBox (#1)** for consumption + roadmap, and ship **VectorNest (#3)** first as a fast wedge that's
  already live and consuming Neon while the bigger build proceeds.
- **If you're bootstrapped / nonprofit / the program is out of reach** (likely, given `fablabfortsmith.org`)
  → optimize for buildable, immediately-useful, clear ROI: lead with **NullCost DR (#22)** (broadest pull) or
  **VectorNest (#3)** (fastest to a paying-ish wedge), and treat TenantForge as the "if it gets traction" v2.

**Default single recommendation if forced to one:** **VectorNest (#3)** as the *first* build — it's the best
risk-adjusted starting point (fast, clear value, real demand, gets a live product consuming Neon), and it
slots cleanly into the bigger TenantForge (#2) story later (each tenant DB = its own vector store). Then
decide TenantForge vs AgentBox for v2 based on whether the program is in play.

## RESOLVED (2026-06-15): no VC → bootstrapped lens locked in

The applying entity is **not VC-backed**, so the $100K program is out and the **N (consumption/
program-fit) criterion no longer matters**. Re-weighting to **F 30% · D 25% · B 25% · M 20% · N 0%**
re-ranks the top tier:

| Idea | F·D·B·M | Re-weighted |
|---|---|---|
| **NullCost DR (#22)** | 5·5·3·3 | **4.10** |
| AgentBox (#1) | 4·4·4·2 | 3.60 |
| VectorNest (#3) | 4·4·4·2 | 3.60 |
| ServerlessShift (#7) | 5·4·2·3 | 3.60 |
| TenantForge (#2) | 4·4·3·3 | 3.55 |
| MaskBranch / MigrateGuard / NeonLens / ErasureEngine | 4·4·3·3 | 3.55 |

**NullCost DR separates as the highest-value target** (it's the biggest, clearest fee kill — the
project's literal objective — with the broadest audience). **Caveat:** DR is high-stakes (failover
*must* work when called), a real reliability burden for a small/bootstrapped team. So:

- **Highest value:** NullCost DR (#22) — but only attempt if you can commit to the reliability bar.
- **Lowest-risk first build (ship + learn):** VectorNest (#3) — low stakes (degraded RAG ≠ disaster),
  fast, clear value; folds into TenantForge (#2) later.
- **v2 / ambition:** TenantForge (#2) if a wedge gets traction.

Program framing also shifts: the goal moves from "submit to the $100K program" to **"build genuinely
useful fee-eliminating Neon tooling on the Free tier; pursue nonprofit/OSS/direct-ask credit paths
opportunistically."**

## What would sharpen this further (next step options)

- A **competitor + pricing teardown** of the top 1–2 (e.g. VectorNest vs Pinecone/Supabase; NullCost DR vs
  managed-DR offerings) to validate the fee-kill delta with real numbers.
- An **architecture sketch + v1 scope** for the chosen finalist (what ships in week 1 vs month 1).
- Confirm the **applying-entity / funding** question, which collapses the decision tree above to one branch.
