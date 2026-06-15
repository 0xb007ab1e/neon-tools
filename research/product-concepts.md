# 10 Tooling Ideas Built on Neon

_Research / ideation — 2026-06-15. Each idea is leverage on a specific Neon primitive
(scale-to-zero, copy-on-write branching, instant API provisioning, PITR/time-travel, pgvector,
Data API, logical replication, regions, MCP). Effort scale: **S** = days–2 wks, **M** = ~1–2 mo,
**L** = 3 mo+ to a real v1. Grounding: see [`neon-research.md`](./neon-research.md)._

---

## 1. AgentBox — ephemeral Postgres sandboxes for AI agents

- **Use case:** AI coding assistants and autonomous agents need a real, isolated, stateful
  database per run/session to execute SQL, test migrations, or persist scratch state — then
  throw it away. A library + control plane provisions a fresh Neon project (or branch) per
  session via the API/MCP, hands the agent a connection string, and tears it down (or just lets
  scale-to-zero idle it) when the run ends.
- **Solves:** the "every agent shares one dirty DB or pays for a throwaway always-on instance"
  problem. Abandoned sandboxes cost **$0** (scale-to-zero), so you can hand out millions.
  Branch-based snapshots give agents undo/rollback of their own state.
- **Doesn't solve:** agent *correctness* or prompt-injection safety (the agent can still run
  destructive SQL inside its sandbox — you've contained blast radius, not eliminated it); cold-
  start latency on first query after suspend (~hundreds of ms) may matter for latency-critical agents.
- **Feasibility:** High. Neon's API + MCP are built for exactly this; Databricks/Neon are
  actively evangelizing it.
- **Effort:** **S–M.** A thin SDK + lifecycle/quota manager is small; multi-language SDKs,
  observability, and per-sandbox policy push it to M.
- **Notes:** Strongest Startup-Program fit (maximum consumption, on-narrative). Risk: Neon may
  ship a first-party version — differentiate on framework integrations (LangChain/LlamaIndex/
  CrewAI), per-tenant quotas, and a clean "DB per agent step with rollback" DX.

## 2. TenantForge — compliant database-per-tenant control plane (BaaS)

- **Use case:** B2B SaaS that wants **hard data isolation** (one Postgres project per customer)
  without building tenant provisioning, routing, migration fan-out, and lifecycle management.
  TenantForge is the control plane: signup → provision tenant project, route connections, run
  schema migrations across all tenants, handle suspend/offboard/export, and pick a per-tenant region.
- **Solves:** (a) the engineering cost of correct multi-tenancy; (b) the per-tenant always-on DB
  tax on RDS (idle tenants are free); (c) a strong compliance story (physical isolation → easy
  HIPAA/SOC2 narrative + per-region data residency). Neon now includes 1,000–10,000 projects,
  making this economical.
- **Doesn't solve:** cross-tenant analytics/reporting (now you must fan-in across N databases);
  the "noisy migration" risk (a schema change must succeed across thousands of projects — needs
  orchestration + rollback); it's overkill for apps that are fine with a shared-schema `tenant_id`.
- **Feasibility:** High technically; medium go-to-market (must out-DX rolling-your-own).
- **Effort:** **M–L.** Provisioning + connection routing is M; fleet-wide migration orchestration,
  observability, and billing metering per tenant push to L.
- **Notes:** Clearest durable-revenue B2B play. Pairs naturally with Neon Auth and with idea #3
  (each tenant DB also holds that tenant's vectors).

## 3. VectorNest — pgvector RAG backend that retires the vector-DB subscription

- **Use case:** Teams doing RAG keep embeddings in Pinecone/Weaviate/Qdrant and their source
  data in Postgres — paying a monthly vector-DB bill and maintaining a dual-write sync.
  VectorNest is an SDK/service that keeps vectors **in the same Neon Postgres** via pgvector,
  with a clean ingest/chunk/embed/query API and branch-based re-embedding.
- **Solves:** the vector-DB subscription **and** the relational↔vector split-brain (one source
  of truth, transactional consistency). Branch → re-embed on a new model → atomic swap removes
  the scary "re-index in place" migration. Low-traffic indexes scale to zero.
- **Doesn't solve:** billion-scale ANN workloads where a dedicated vector engine genuinely wins
  on latency/recall (pgvector is excellent to the low-millions, not infinite); you still own the
  embedding-model choice and chunking quality (the hard part of RAG).
- **Feasibility:** High. pgvector is mature; the value is DX + the migration ergonomics.
- **Effort:** **S–M.** Core SDK is S; managed ingestion pipeline, rerankers, and eval tooling → M.
- **Notes:** Easiest "cancel a bill" pitch. Competition: Supabase pushes the same story — win on
  the branch-to-re-embed workflow and tighter Neon-native ergonomics.

## 4. PreviewDB — full-stack ephemeral preview environments (beyond Vercel)

- **Use case:** CI creates a database branch per pull request, seeds/masks it, injects per-branch
  secrets, and tears it down on merge — for teams **not** on Vercel (GitHub Actions, GitLab CI,
  CircleCI, self-hosted, AWS/GCP deploys). A GitHub App + CI action orchestrates it.
- **Solves:** standing staging-DB cost, manual seed/reset toil, and "shared staging is always
  broken." Copy-on-write branches are near-free and instant; every PR gets a clean, prod-shaped DB.
- **Doesn't solve:** the non-DB half of a preview env (compute, queues, third-party sandboxes) —
  unless you orchestrate those too; and it partially overlaps Neon's own GitHub/Vercel integrations,
  so a naive clone has thin differentiation.
- **Feasibility:** High technically; **moat is the concern** (Neon ships first-party branching CI).
- **Effort:** **M.** The orchestration + masking + secrets wiring across CI providers is the work.
- **Notes:** Differentiate by bundling **PII masking (idea #7)** + per-branch secrets + multi-service
  ephemeral envs, targeting stacks Neon's own integrations don't cover well.

## 5. Rewind — production "time machine" for support, debugging & incident repro

- **Use case:** On-call/support engineers need to see the database **as it was** at a moment in
  time — to reproduce a customer's exact state, debug a bad deploy, or run a heavy/dangerous
  forensic query — without touching prod or paying for an always-on read replica. Rewind spins an
  instant PITR branch at timestamp T, opens a read-only (or scratch) console, and auto-suspends after.
- **Solves:** read-replica cost for ad-hoc analytics; the risk of querying prod directly; the
  slow/expensive full-backup restore just to inspect past state. Branch + scale-to-zero = cheap,
  disposable time travel.
- **Doesn't solve:** investigations needing data older than your history-retention window;
  workloads needing a *continuous* replica for live dashboards (that's a steady read replica, not
  an ephemeral branch).
- **Feasibility:** High — directly maps to Neon PITR + branching.
- **Effort:** **S–M.** A CLI + web console over the branch API is S; saved investigations, RBAC,
  and audit logging → M.
- **Notes:** Great internal-tools / DevEx wedge; natural add-ons: "reproduce this Sentry error's
  DB state," "diff prod between two deploys."

## 6. MaskBranch — automatic PII anonymization & synthetic seeding for branches

- **Use case:** The "no real personal data in non-prod" mandate (GDPR/HIPAA/SOC2) makes dev/test
  data a chore. MaskBranch creates a branch from prod and **transforms it in place**: detects PII
  by schema/heuristics, applies masking/pseudonymization/synthesis, and produces a safe,
  realistically-shaped branch for dev, CI (idea #4), or demos (idea #8).
- **Solves:** the compliance blocker on using prod-shaped data downstream, plus the overhead of
  hand-building seed scripts. Copy-on-write means the masked branch is cheap; you transform once.
- **Doesn't solve:** guaranteeing *zero* leakage on exotic free-text/JSON columns (detection is
  best-effort — needs human-reviewed rules); referential-integrity-preserving synthesis for
  complex graphs is genuinely hard.
- **Feasibility:** Medium. Core masking is straightforward; trustworthy auto-detection and
  format-preserving synthesis are the hard, defensible parts.
- **Effort:** **M.** Detection rules engine + transforms + verification report.
- **Notes:** Strong as a **feature inside #4/#8**, or standalone as a compliance tool. Defensibility
  lives in detection accuracy + an auditable "what we masked" report.

## 7. ServerlessShift — Postgres FinOps: RDS/Aurora → Neon migration & right-sizing

- **Use case:** A tool that ingests an org's RDS/Aurora/Cloud SQL utilization, flags databases
  that are **idle, spiky, or over-provisioned**, models the savings of moving them to Neon
  (autoscaling + scale-to-zero), and assists/automates the migration (logical replication cutover).
- **Solves:** the over-provisioning waste that defines most managed-Postgres bills; the analysis
  paralysis of "which of our 200 databases should be serverless?" Sells a concrete dollar number.
- **Doesn't solve:** workloads that are genuinely steady-state high-traffic (serverless may not be
  cheaper there); cutover risk for stateful prod DBs (migration is never zero-risk); features tied
  to a specific managed provider (e.g. AWS-native extensions).
- **Feasibility:** Medium. Read-only analysis is easy; trustworthy automated migration is hard and
  high-stakes.
- **Effort:** **M–L.** Analyzer is M; safe automated migration tooling is L.
- **Notes:** Services-heavy, slower to scale than a pure SaaS, but a powerful **lead-gen / wedge**
  and very aligned with Neon's "stop paying for idle" message. Could start as a free analyzer.

## 8. DemoLoop — reset-able, pre-seeded demo & trial environments

- **Use case:** Sales engineers and PLG trials need a clean, pre-populated environment per
  prospect that **resets on demand** and costs nothing when nobody's poking it. DemoLoop keeps a
  "golden" seed branch; each prospect/trial gets a child branch; "reset" re-branches from golden;
  idle demos scale to zero.
- **Solves:** demo-environment rot ("someone broke the demo data"), the cost of keeping many
  seeded demo/trial DBs always-on, and slow trial provisioning. Instant branch = instant fresh demo.
- **Doesn't solve:** the non-DB parts of a demo (the app itself, third-party integrations); demos
  needing live external data feeds.
- **Feasibility:** High. Pure branch lifecycle management.
- **Effort:** **S–M.** Branch manager + reset API is S; embeddable "Try it" widget + analytics → M.
- **Notes:** Niche but sticky; good consumption. Sells to GTM/DevRel teams, an underserved buyer.

## 9. LiteSync — per-user database backend for local-first / offline apps

- **Use case:** Local-first and offline-capable apps need a per-user cloud database to sync to.
  Building that sync backend — and paying for a always-on DB per user — is prohibitive. LiteSync
  gives **each user their own Neon project/branch** (scale-to-zero so dormant users are free) and
  a sync protocol (logical replication / change feeds) between the user's local store and their
  cloud DB.
- **Solves:** the per-user always-on cost that makes DB-per-user impractical elsewhere, and the
  build cost of a bespoke sync server. Dormant users (the majority, always) cost nothing.
- **Doesn't solve:** conflict resolution / CRDT semantics (the genuinely hard part of sync — you
  still design that); collaborative multi-user-on-one-doc realtime (that's a different model);
  cold-start latency on a dormant user's first sync.
- **Feasibility:** Medium-hard. Provisioning is easy; a correct, efficient sync protocol is the deep work.
- **Effort:** **L.** Sync correctness, offline conflict handling, and client SDKs are substantial.
- **Notes:** Most novel/ambitious; biggest moat if the sync layer is good. Competes conceptually
  with ElectricSQL/PowerSync — differentiate on the "free when dormant" per-user economics.

## 10. MigrateGuard — branch-based migration CI gate & zero-downtime linter

- **Use case:** Schema migrations are the #1 cause of avoidable prod incidents. MigrateGuard runs
  each proposed migration against a **fresh branch of production schema+data** in CI, then checks:
  does it apply cleanly, does it take long/blocking locks, is it backward-compatible
  (expand/contract), does it break existing queries, how long does the backfill take on real data
  volume? It blocks the PR on violations and reports the real-world impact.
- **Solves:** the "migration looked fine on an empty staging DB, locked prod for 8 minutes"
  incident; the overhead of maintaining a prod-sized staging DB just to test migrations. Branch =
  prod-shaped test bed, instant and disposable.
- **Doesn't solve:** application-level migration logic bugs beyond schema/lock analysis;
  data-correctness of backfills (it measures cost/safety, not business correctness).
- **Feasibility:** High. Branch API + Postgres lock/EXPLAIN introspection are well-trodden.
- **Effort:** **M.** The CI integration is small; the lock/compat/backfill analysis engine is the
  substance.
- **Notes:** Crisp DevEx tool with an obvious "prevented an outage" ROI story. Pairs with #4
  (preview envs) and #6 (masked data). Strong fit for the program's "branching for testing /
  CI automation" featured use cases.

---

## Quick comparison

| # | Name | Fee/overhead killed | Effort | Program fit | Moat risk |
|---|---|---|---|---|---|
| 1 | AgentBox | throwaway-DB cost for agents | S–M | ★★★★★ | Neon may ship native |
| 2 | TenantForge | multi-tenancy build + idle-tenant tax | M–L | ★★★★★ | build-your-own |
| 3 | VectorNest | vector-DB subscription + sync | S–M | ★★★★☆ | Supabase overlap |
| 4 | PreviewDB | staging cost + seed toil | M | ★★★☆☆ | Neon-native overlap |
| 5 | Rewind | read-replica + restore cost | S–M | ★★★☆☆ | low |
| 6 | MaskBranch | non-prod-data compliance blocker | M | ★★★☆☆ | detection accuracy |
| 7 | ServerlessShift | RDS over-provisioning waste | M–L | ★★★★☆ | services-heavy |
| 8 | DemoLoop | demo/trial env upkeep + idle cost | S–M | ★★★☆☆ | niche |
| 9 | LiteSync | per-user always-on + sync-server build | L | ★★★★☆ | hard problem |
| 10 | MigrateGuard | staging-for-migrations + outage risk | M | ★★★★☆ | low |

> Synergy clusters worth noting: **#4 + #6 + #10** form a coherent "CI/branch data platform";
> **#2 + #3** form an "isolated tenant with built-in vectors" backend; **#1** stands alone as the
> highest-consumption, most on-trend bet.

---

# Round 2 — 10 more ideas (clustered)

_Same breakdown. Each notes whether it **extends** a Round-1 idea or is **new**. The clusters below
are the productizable units — several Round-1 + Round-2 ideas combine into one shippable platform._

## Cluster A — Branch-native CI & data-quality platform (extends #4, #6, #10)

### 11. SchemaDiff/DataDiff — "PR review for your database" _(new; extends #10)_
- **Use case:** A GitHub/GitLab app that, on each PR, diffs the **schema** and a **sampled slice of
  data** between the base branch and the PR's database branch, and posts a human-readable review
  comment ("adds non-null column without default → blocking lock; 3 rows now violate new CHECK").
- **Solves:** silent schema/data regressions that pass tests but break prod; reviewers having no
  visibility into the *data* impact of a migration. Copy-on-write branches make the comparison cheap.
- **Doesn't solve:** semantic correctness of the change (it shows *what* changed, not whether it's
  *right*); diffing huge tables needs sampling/heuristics, not full scans.
- **Feasibility:** High — branch API + catalog/`information_schema` introspection. **Effort: M.**
- **Extra:** The review-surface companion to MigrateGuard (#10): #10 *gates*, #11 *explains*. Together
  they're "data-aware code review."

### 12. FixtureForge — test-data-as-code with golden snapshot branches _(new; extends #6, #8)_
- **Use case:** Declarative fixtures (`fixtures.yaml` / code) materialized into a **golden branch**;
  tests fork a child branch per suite, run, and discard. "Reset DB" is a re-branch, not a truncate-and-reseed.
- **Solves:** slow per-test seeding, flaky shared test state, and order-dependent tests; near-instant
  isolation per test/suite. Pairs with MaskBranch (#6) to seed from masked prod instead of synthetic.
- **Doesn't solve:** the design of good fixtures (still yours); very-high-parallelism test fleets may
  hit branch-creation rate/quota limits — needs pooling.
- **Feasibility:** High. **Effort: S–M.**
- **Extra:** Plugs into Jest/Vitest/pytest/Go test as a driver; the "branch-per-test" pattern is the hook.

## Cluster B — Agent & AI infrastructure (extends #1, #3)

### 13. MemoryVault — branchable long-term memory for AI agents _(new; extends #1, #3)_
- **Use case:** A managed agent-memory store in Postgres (episodic log + semantic/pgvector recall)
  where an agent's memory can be **forked** (branch) to explore a path and **time-traveled** (PITR) to
  roll back a bad trajectory.
- **Solves:** the lack of durable, inspectable, *versionable* agent memory; combines relational facts
  + vector recall in one store (no separate vector DB — leans on #3); dormant agents' memory scales to zero.
- **Doesn't solve:** memory *policy* (what to remember/forget, summarization strategy — that's app logic);
  cross-agent shared-memory consistency.
- **Feasibility:** High. **Effort: M.**
- **Extra:** Natural upsell to AgentBox (#1): sandbox = scratch compute, MemoryVault = persistent brain.

### 14. EvalBranch — reproducible LLM/agent evals on frozen data _(new)_
- **Use case:** Pin an eval/golden dataset to an immutable branch; run model/prompt/agent versions
  against the *exact same* frozen data; compare scores across runs with guaranteed data parity.
- **Solves:** the "evals aren't reproducible because the underlying data drifted" problem; cheap to keep
  dozens of pinned eval snapshots (scale-to-zero + shared storage).
- **Doesn't solve:** the eval *metrics/graders* themselves (you bring the judge); non-DB eval inputs
  (files, APIs) unless you snapshot those too.
- **Feasibility:** High. **Effort: S–M.**
- **Extra:** Slots into CI next to MigrateGuard (#10)/SchemaDiff (#11) as the "AI quality gate."

### 15. AskData — embeddable text-to-SQL analytics over the Data API _(new)_
- **Use case:** Drop-in natural-language analytics for SaaS apps: ship customer-facing "ask your data"
  over Neon's **HTTP Data API**, per-tenant, scale-to-zero so low-use analytics cost nothing.
- **Solves:** the cost/complexity of bolting on an analytics tier (and its always-on warehouse bill) for
  low-to-moderate query volume; no backend needed (Data API).
- **Doesn't solve:** text-to-SQL safety/accuracy (needs guardrails, read-only roles, query allow-listing
  — real risk); heavy OLAP (Postgres isn't a columnar warehouse at scale).
- **Feasibility:** Medium (the safety layer is the work). **Effort: M.**
- **Extra:** Strong fit with TenantForge (#2) — each tenant's isolated DB gets isolated NL analytics.

## Cluster C — Multi-tenant compliance & lifecycle (extends #2)

### 16. ResidencyRouter — data-residency / geo control plane _(new; extends #2)_
- **Use case:** Map each tenant to a Neon **region**, route connections accordingly, and emit an
  auditable "this customer's data lives in EU/US" attestation. A policy + routing layer over project-per-tenant.
- **Solves:** data-residency requirements (GDPR/sovereignty) without per-region standing infra cost;
  turns residency into a per-tenant config flag.
- **Doesn't solve:** residency of data *outside* Postgres (logs, backups elsewhere, third-party processors);
  cross-region tenant migration is non-trivial.
- **Feasibility:** Medium. **Effort: M.**
- **Extra:** A premium feature *of* TenantForge (#2) more than a standalone — but a strong enterprise upsell.

### 17. ErasureEngine — automated GDPR/CCPA export & deletion per tenant _(new; extends #2)_
- **Use case:** On a data-subject erasure/export request, locate and export or **delete** a tenant's data;
  with project-per-tenant, full erasure can be "drop the project" — clean, provable, complete (incl. backups
  via retention expiry).
- **Solves:** the perennial "right to be forgotten" engineering burden and the hard problem of erasing from
  backups/replicas — isolation makes erasure a control-plane action, not a cross-table hunt.
- **Doesn't solve:** data copied *out* of the tenant DB (analytics warehouses, logs — needs separate handling);
  legal-hold conflicts (must respect retention obligations).
- **Feasibility:** High for the per-project case. **Effort: M.**
- **Extra:** Best as a TenantForge (#2) module; sells itself to any regulated buyer.

### 18. AuditVault — per-tenant append-only audit & compliance-evidence store _(new; extends #2)_
- **Use case:** An isolated, append-only/tamper-evident audit log per tenant (SOC2/ISO/HIPAA evidence),
  cheap because idle tenant logs scale to zero, queryable for audits, time-travel via PITR.
- **Solves:** the cost of always-on per-tenant audit infrastructure and the "prove non-repudiation per
  customer" requirement; isolation simplifies the access-control story.
- **Doesn't solve:** true immutability guarantees beyond Postgres (for high-assurance, pair with WORM
  storage / hash-chaining — Postgres append-only is tamper-*evident*, not tamper-*proof*).
- **Feasibility:** High. **Effort: S–M.**
- **Extra:** Rounds out the C-cluster: TenantForge (#2) + Residency (#16) + Erasure (#17) + AuditVault (#18)
  = a **"compliant multi-tenant data plane"** — a single, very saleable enterprise platform.

## Cluster D — Neon-native cost & resource hygiene (extends #7)

### 19. NeonLens — cost observability + autoscale/scale-to-zero tuner _(new; extends #7)_
- **Use case:** A dashboard + agent that watches CU-hours, storage, and branch spend **across many Neon
  projects**, recommends (or auto-applies) scale-to-zero timeouts and autoscale caps, and enforces per-project/
  per-tenant spend guardrails with alerts.
- **Solves:** cost surprises and mis-tuned suspend/autoscale settings at fleet scale (exactly the risk when
  you run thousands of projects à la TenantForge/AgentBox); turns Neon's own knobs into managed policy.
- **Doesn't solve:** workload redesign (it tunes config, doesn't rewrite slow queries); it's Neon-specific
  (vs ServerlessShift #7 which is cross-provider migration).
- **Feasibility:** High — Neon billing/consumption APIs + a policy engine. **Effort: M.**
- **Extra:** The FinOps complement to #7: **#7 gets you onto Neon, #19 keeps you efficient there.** Almost
  mandatory companion for any high-project-count product in this collection.

### 20. BranchReaper — orphaned branch/project garbage collector & TTL policies _(new)_
- **Use case:** Find and reap abandoned branches/projects across an org (stale PR branches, dead agent
  sandboxes, forgotten experiments) by TTL/last-activity policy, with a safe quarantine-then-delete flow.
- **Solves:** silent **branch sprawl** — branches and projects accrue storage and management overhead even
  with scale-to-zero (storage isn't free, and quotas/limits are real). Reclaims spend and headroom.
- **Doesn't solve:** deciding intent (needs good policy + a grace/restore window so it never reaps something
  loved — destructive, so gate carefully); it's janitorial, not revenue-generating on its own.
- **Feasibility:** High. **Effort: S.**
- **Extra:** A natural feature of NeonLens (#19) and a safety net under every branch-heavy idea (#1, #4, #8,
  #11, #12). Small, but everyone running Neon at scale eventually needs it.

---

## Productizable clusters (the real "what to build" units)

| Cluster | Ideas | Pitch | Composite effort |
|---|---|---|---|
| **A. Branch-native CI / data platform** | #4, #6, #10, #11, #12 | "Data-aware code review + prod-shaped, compliant test data, on every PR." | M–L |
| **B. AI/agent data infrastructure** | #1, #3, #13, #14, #15 | "Sandbox + memory + vector + reproducible evals — the data layer for agents." | M–L |
| **C. Compliant multi-tenant data plane** | #2, #16, #17, #18 | "Isolated DB per customer with residency, erasure, and audit built in." | L |
| **D. Neon FinOps & hygiene** | #7, #19, #20 | "Get onto serverless Postgres, then keep it cheap and clean at fleet scale." | M |
| **(standalone)** | #5 Rewind, #9 LiteSync | Time-machine tooling / local-first per-user backend. | S–M / L |

> Read across the two rounds: most single ideas are **features of one of these four platforms**. The
> highest-leverage move is to pick **one cluster** as the product and treat the others as the roadmap —
> Cluster B (AI/agent) for consumption + market heat, Cluster C (compliant multi-tenant) for enterprise
> revenue, Cluster A (CI/data) for the crispest DevEx wedge, Cluster D as the companion every cluster needs.

---

# Round 3 — wildcard net-new primitives

_These are deliberately further out: each introduces a **new abstraction** ("the primitive") that
Neon's mechanics make newly cheap or possible. Higher risk, less proven demand — idea fuel, not safe bets.
Each names the primitive explicitly. Honesty flags are heavier here (legal/safety/market-unproven)._

### 21. TimeFork — counterfactual / "what-if" simulation on forked reality
- **Primitive:** *the counterfactual database* — fork the present and run an alternate history against it.
- **Use case:** Branch the live DB at time T, then **replay an alternate stream of events/inputs** (different
  prices, a different ruleset, a reversed decision) and compare outcomes to the real timeline. Pricing/ops
  simulation, financial backtesting, "what if we'd rolled this out?" analysis, game-balance testing.
- **Solves:** the impossibility/cost of testing decisions against *real* state — normally you can't safely
  fork production and let it diverge. Branch + PITR makes parallel realities cheap and disposable.
- **Doesn't solve:** modeling the *world's* reaction (you replay inputs you supply; it won't predict how
  users would actually behave); requires the app's logic to be replayable against a branch (event-sourced
  or deterministic-ish systems fit best).
- **Feasibility:** Medium — branching is trivial; the **replay harness** is domain-specific and the hard part.
- **Effort:** **M–L.** Best as a vertical tool (e.g. fintech backtesting) rather than generic.
- **Extra:** Most compelling where decisions are expensive and data is rich (finance, logistics, games).

### 22. NullCost DR — a disaster-recovery standby that costs $0 at rest
- **Primitive:** *the free warm standby* — a cross-provider replica you don't pay for until you need it.
- **Use case:** Continuously **logical-replicate** a primary (RDS/Aurora/Cloud SQL/self-hosted) into a Neon
  standby that **scales to zero**. It sits warm-but-suspended for ~$0 compute (you pay only storage); on
  failover it wakes in seconds. Cross-cloud DR without a second always-on instance bill.
- **Solves:** the classic DR tax — paying full price for a standby that does nothing 99.9% of the time.
  Turns "can we afford a DR replica?" into yes for everyone.
- **Doesn't solve:** sub-second RPO/RTO (replication lag + wake latency exist — fine for most, not for HFT);
  failback complexity; feature parity if the primary uses provider-specific extensions.
- **Feasibility:** Medium — logical replication is standard; the value is the orchestration + failover runbook.
- **Effort:** **M.**
- **Extra:** Unusually *broad* appeal for a wildcard — nearly every prod DB "should" have DR and skips it on cost.

### 23. DataPort — ship software with its own free cloud database (DB-as-a-deliverable)
- **Primitive:** *the embedded backend* — any installer/CLI/desktop app provisions its own cloud DB on first run.
- **Use case:** A library/SDK so that desktop apps, CLIs, OSS tools, and indie products **provision a Neon
  project on first launch** (via a brokered/scoped flow) and get a real cloud Postgres + sync for free-when-idle.
  "Download the app, it brings its own backend."
- **Solves:** the indie/OSS dilemma — shipping a real backend means running (and paying for) servers. Scale-to-zero
  makes a per-install cloud DB economically viable; no backend ops for the developer.
- **Doesn't solve:** the credential/abuse model (who owns/pays for the provisioned project? you need a broker,
  quand quota/anti-abuse layer — the genuinely hard part); offline-first needs a sync story (see LiteSync #9).
- **Feasibility:** Medium-hard — the provisioning **broker + billing/abuse model** is the work, not the DB.
- **Effort:** **L.**
- **Extra:** If solved well, this is a platform (you're the broker between app developers and Neon). High consumption.

### 24. ForkLedger — point-in-time audit attestations / notarized database states
- **Primitive:** *the notarized snapshot* — a cryptographically attested, re-instantiable database state.
- **Use case:** At fiscal close / audit / regulatory checkpoint, freeze an **immutable branch**, hash-chain it,
  and issue a signed attestation ("the books exactly as of 2026-06-30, re-queryable on demand"). Auditors get a
  live, isolated, read-only copy of that exact state instead of a CSV dump.
- **Solves:** the gap between "a backup file" and "a provable, queryable historical state"; cheap retention of
  many notarized checkpoints (shared storage); auditors self-serve without touching prod.
- **Doesn't solve:** true tamper-*proof*ness on its own (Postgres gives tamper-*evidence*; pair with external
  hash anchoring/WORM for high assurance); legal admissibility varies by jurisdiction.
- **Feasibility:** High technically. **Effort: M.**
- **Extra:** Niche but high-value in finance/regulated; complements AuditVault (#18).

### 25. DecoyDB — disposable honeypot databases for threat detection (defensive)
- **Primitive:** *the free honeypot fleet* — realistic decoy databases you can deploy by the hundred for ~$0.
- **Use case:** Spin up realistic-looking decoy Postgres instances (canary tables, fake creds, seeded "secrets")
  across an environment; any connection/query to one is a high-signal intrusion alert. Scale-to-zero makes a large
  deception fleet essentially free; branch a masked-prod shape (#6) so decoys look real.
- **Solves:** the cost/effort of deception infrastructure — normally you can't afford many honeypots. Cheap fleet +
  realistic shape = better attacker detection.
- **Doesn't solve:** prevention (it *detects*, doesn't block); a sophisticated attacker may fingerprint Neon/decoys;
  this is **defensive** deception only — must be deployed in environments you own/are authorized to monitor.
- **Feasibility:** High. **Effort: S–M.**
- **Extra:** Pairs with MITRE-ATT&CK-style detection; clean defensive-security positioning.

### 26. LiveShare Data — share a live, queryable database like a Doc link
- **Primitive:** *the shareable live dataset* — a URL that is a real, queryable, scale-to-zero database.
- **Use case:** Turn any branch into a **read-only (or scoped-write) live dataset** exposed via the HTTP Data API
  behind a shareable link. Recipients query *live data*, not a stale export; the dataset costs $0 when nobody's
  querying. "Send someone a database, not a CSV."
- **Solves:** the stale-export problem (CSV/Parquet dumps go out of date instantly) and the cost of hosting many
  shared datasets; instant, revocable, cheap data sharing.
- **Doesn't solve:** governance at scale (who can see what — needs row-level scoping + revocation + rate limits);
  abuse/cost control on public links (a viral link could rack up CU-hours — needs caps).
- **Feasibility:** Medium (the access-control + abuse layer is the work). **Effort: M.**
- **Extra:** Data-journalism, open data, research distribution, "live appendix" for reports. Underexplored space.

### 27. ObjectDB — a database per object (per doc / thread / match / board)
- **Primitive:** *database-per-entity* — push isolation down from per-tenant to per-object.
- **Use case:** Each high-value object — a Notion-style doc, a chat thread, a game match/lobby, a collaborative
  board, a workflow run — gets its **own** Postgres (project/branch). Scale-to-zero makes millions of mostly-idle
  objects free; isolation is absolute; PITR gives per-object history/undo.
- **Solves:** the limits of "everything in one big table with an `object_id`" — per-object isolation, history,
  portability (export one object's DB), and blast-radius containment, at a granularity that was never affordable before.
- **Doesn't solve:** cross-object queries/search (now a fan-in/aggregation problem — needs an index layer);
  connection-management at extreme object counts (pooling/routing is essential); likely hits project/branch
  quotas fast (needs the BranchReaper #20 + NeonLens #19 hygiene layer).
- **Feasibility:** Medium-hard at scale (routing + aggregation are real engineering). **Effort: L.**
- **Extra:** The most extreme expression of Neon's economics; enormous consumption; genuinely novel architecture.

### 28. RealClone — load, chaos & destructive testing against disposable prod clones
- **Primitive:** *the disposable prod twin* — hammer a real copy of production, then throw it away.
- **Use case:** Branch production (optionally masked, #6), run **load tests, chaos/fault injection, destructive
  schema experiments, or migration rehearsals** against the real data shape and volume, capture results, discard.
- **Solves:** the "load tests on a toy staging DB lie" problem and the danger of destructive testing — now you can
  break a *real* copy safely and cheaply.
- **Doesn't solve:** reproducing production *traffic* patterns (you supply the load generator); compute on a branch
  may not mirror prod hardware exactly (results are directional).
- **Feasibility:** High. **Effort: S–M.**
- **Extra:** Sits beside MigrateGuard (#10)/RealClone in CI as the "test against reality" capability; great for SRE/perf teams.

### 29. RewindMe — end-user "undo my account" / app-level time travel as a service
- **Primitive:** *user-facing time travel* — expose PITR safely to an application's own end users.
- **Use case:** An SDK that lets app builders offer their users a literal **"restore my account/workspace to
  yesterday"** — selective, scoped point-in-time restore of just that user's/tenant's data (cleanest with
  per-tenant or per-object DBs, #2/#27), with preview-before-commit.
- **Solves:** the universally-wished-for "undo" that almost no app offers because per-user time travel is hard;
  turns Neon PITR into a product feature end users feel.
- **Doesn't solve:** scoping restore to one user inside a *shared* DB (hard — far easier with #2/#27 isolation);
  conflict with concurrent activity during restore; data created *after* the restore point (needs clear UX).
- **Feasibility:** High with per-tenant/per-object isolation; hard in a shared schema. **Effort: M.**
- **Extra:** A delightful, differentiating feature any SaaS would pay to add; strongest atop Cluster C or ObjectDB.

### 30. CleanRoom — ephemeral, zero-residue data-collaboration clean rooms
- **Primitive:** *the disposable joint-compute environment* — two parties' data meet, compute, and vanish.
- **Use case:** Two organizations want a single joint computation (overlap analysis, joint ML feature, matching)
  without either retaining the other's raw data. Provision an **ephemeral isolated branch**, load both inputs, run
  the agreed query, return *only the result*, then **destroy** the environment — verifiably leaving no residue.
- **Solves:** the trust barrier in data collaboration — neither side keeps the other's data; isolation +
  instant-create + guaranteed-destroy is the enabler. Cheap because it exists only for the computation.
- **Doesn't solve:** the deeper privacy guarantees (differential privacy / secure-enclave-grade assurance — this is
  *isolation + deletion*, not cryptographic MPC); the legal agreement governing the join (you provide plumbing, not contracts).
- **Feasibility:** Medium. **Effort: M–L.**
- **Extra:** Lightweight "data clean room" for the long tail that can't afford Snowflake/enterprise clean rooms.

---

## Round 3 at a glance

| # | Name | New primitive | Effort | Reality check |
|---|---|---|---|---|
| 21 | TimeFork | counterfactual database | M–L | needs replayable app logic; go vertical |
| 22 | NullCost DR | free warm standby | M | broadest appeal; RPO/RTO limits |
| 23 | DataPort | embedded backend / DB-as-deliverable | L | hard part = broker + abuse/billing |
| 24 | ForkLedger | notarized snapshot | M | tamper-evident, not tamper-proof |
| 25 | DecoyDB | free honeypot fleet | S–M | defensive only; detect ≠ prevent |
| 26 | LiveShare Data | shareable live dataset | M | governance + public-link cost caps |
| 27 | ObjectDB | database-per-entity | L | cross-object query + quotas are real |
| 28 | RealClone | disposable prod twin | S–M | directional, not hardware-exact |
| 29 | RewindMe | user-facing time travel | M | easy with #2/#27 isolation, hard shared |
| 30 | CleanRoom | zero-residue joint compute | M–L | isolation+deletion, not MPC-grade |

**Honorable-mention seeds (not fully worked):** *DataVCS* (Git-for-data — commit/branch/merge/PR for datasets,
branches as the substrate); *Personal Data Wallet* (each user owns their own DB; apps get scoped access — data-ownership
inversion); *SynthFactory* (branch → generate synthetic data at real volume/shape → export); *EdgeView* (on-demand
read-replica materialized views that scale to zero).

> Cross-round note: the wildcards that **pair with an isolation cluster** (C or ObjectDB) — RewindMe (#29),
> ForkLedger (#24), CleanRoom (#30) — are the most buildable, because per-tenant/per-object isolation is what
> makes user-facing time travel, notarization, and zero-residue compute *easy* instead of *hard*.
