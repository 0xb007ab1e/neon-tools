# TenantForge — Pivot / Extension Directions (research)

> **Status: research draft (2026-06).** Goal: reposition TenantForge to **extend** Neon's
> primitives and fill what Neon leaves to the builder — **not duplicate Neon**. Ranked by
> **defensibility vs. Neon** (least overlap, hardest for Neon to absorb, reliant on builder-only
> knowledge). `main` is frozen; nothing here is implemented yet.
>
> **Provenance:** synthesized by hand from a `deep-research` run (22 primary sources, 101 extracted
> claims). The run's adversarial-verification + synthesis steps repeatedly hit session limits, so
> only a subset of claims got the full 3-vote pass. Confidence is tagged inline:
> **✅ = adversarially verified** (vote shown) · **🟡 = primary-sourced, verification incomplete**.

## 1. Neon ground truth (what NOT to rebuild vs. the open space)

**Native — do not reinvent:**

- ✅ (3-0) Near-instant project-per-tenant provisioning, scale-to-zero, branching, per-customer PITR. [neon.com/docs/guides/multitenancy]
- ✅ (3-0) Agent Plan exposes provisioning, quotas, branching, instant-restore, snapshots via the Neon API; ✅ (3-0) targets high-volume per-tenant fleets (≈30k projects/org). [neon.com/docs/introduction/agent-plan]
- ✅ (2-1) Consumption API tracks usage across orgs/projects → **metering is native** (🟡 raw values only; bill calc is the builder's). [neon.com/blog/neon-for-agent-platforms]
- ✅ (2-1) Dual-org tier model: the builder's control plane picks `NEON_ORG_ID` per tier + transfers projects on upgrade. [neon.com/blog/neon-for-agent-platforms]
- 🟡 Official `neon-bulk-migrator` runs fleet schema migrations — **execution only** (no drift detection, no lifecycle, no auth/billing). [github.com/neondatabase/neon-bulk-migrator]
- 🟡 `db-per-tenant` reference app is narrow (≈4 DBs, schema rollout) — **does not** address offboarding, routing, billing, or compliance. [github.com/neondatabase/ai-vector-db-per-tenant]

**Builder space Neon explicitly leaves open:**

- ✅ (3-0) Auth-driven **user→tenant routing** is an application-layer responsibility. [multitenancy]
- ✅ (3-0) Neon tells you to **build your own catalog/registry DB** (it ships the pattern, not the service). [multitenancy]
- ✅ (2-0) The Agent Plan **does not** specify auth mapping, connection routing, or **billing orchestration**. [agent-plan]

**Competitive context:** ⚠️ **Nile** (thenile.dev) — multi-tenant Postgres, a direct framing competitor. OSS usage-billing incumbents: **stripemeter, meteroid, flexprice**. GRC/evidence incumbents: Vanta / Drata / Secureframe (org-level, not per-tenant-DB-level).

## 2. Ranked shortlist (defensibility lens)

1. **Compliance & governance evidence layer** — 🥇 highest moat, most reuse. _(deep dive §3)_
2. **Fleet drift detection + desired-state reconciliation** — bulk-migrator stops at execution; the controller above it is open. Reuses the drift asset. Risk: incrementally absorbable.
3. **Usage→billing / per-tenant cost attribution** — 🥈 clearest fee-kill, weaker moat. _(deep dive §4)_
4. **Auth→tenant routing SDK** — verified-open (3-0) but thin glue; Nile/ABP bundle it. Medium.
5. **Lifecycle↔external-system saga** (webhooks → billing/CRM/non-Neon teardown). Medium.
6. **Per-tenant secret/credential broker** — security plumbing; Vault-class incumbents. Lower.

---

## 3. Deep dive — Compliance & governance evidence layer (recommended core)

**Thesis.** "Make your Neon database-per-tenant fleet **audit-ready**." Neon gives you the isolation
primitive and even markets it for HIPAA/SOC2 — but stops there. The defensible product is the
**policy + evidence** layer on top: provable erasure, enforced residency, attributable audit, and
auditor-consumable evidence bundles.

**The gap (builder-only knowledge).** Compliance posture depends on facts Neon can't know: _which_
frameworks apply (GDPR/HIPAA/SOC2/CCPA), your **data classification**, your **retention policy**,
your **DSAR** process, your residency obligations per customer. Neon is an infra company; it will
not encode each customer's compliance posture. ✅ (3-0) confirms Neon punts the application layer.

**Capabilities (mostly assembling existing assets):**

- **Verifiable right-to-erasure** — export → delete project → crypto-shred per-tenant key → verify →
  **signed certificate** (already built). Deepen: tie the cert to the audit record + an object-store
  evidence artifact.
- **Residency enforcement + attestation** — refuse non-compliant regions (built) **and** emit a
  fleet attestation report: "no tenant resides outside its jurisdiction's allow-list."
- **Immutable, operator-attributed audit** (built) → exportable, tamper-evident trail of who-did-what.
- **Proof-of-isolation report** — each tenant = a separate Neon project (one query over the registry).
- **Evidence bundle** — a signed, timestamped pack (erasure certs + residency attestation + audit
  excerpt + isolation proof) per tenant or fleet, for an auditor or enterprise customer's security review.

**Reuses (highest of any direction):** erasure+certificate engine, residency enforcement, audit
stream, per-tenant secret custody (the keys whose destruction _is_ the erasure proof), object stores
(evidence at rest), webhooks (notify on erasure/DSAR), all four entrypoints.

**Defensibility.** Policy + proof, not infra — structurally outside Neon's business. GRC tools
(Vanta/Drata) operate at the _org_ level and won't produce _per-tenant-database_ evidence over a
Neon fleet; that fleet-specific evidence is the wedge.

**Fee-kill / immediately-useful.** Compliance evidence today is manual toil (spreadsheets, ad-hoc
SQL, screenshots) — expensive for a bootstrapped B2B SaaS chasing its first enterprise/regulated
deals. A one-command signed evidence bundle is immediately useful and reuses code that already exists.

**Smallest first slice (MVP).** A `compliance-report <tenantId|--fleet>` command (CLI + HTTP) that
emits a signed evidence bundle from already-built pieces (erasure history, residency attestation,
audit excerpt, isolation proof). Near-zero net-new domain logic; it's packaging.

**Risks / honesty.** Compliance is trust-heavy — **do not claim legal guarantees**; the tool emits
_evidence_, not _certification_. Crypto-shredding's "erasure" has known caveats (backups, replicas) —
document them. GRC incumbents exist (but at a different altitude). Adversarial check: ensure each
"attestation" maps to a real, queryable fact, not a vibe.

---

## 4. Deep dive — Usage→billing / per-tenant cost attribution (strong fee-kill, weaker moat)

**Thesis.** Turn Neon's raw consumption into **per-tenant cost + margin attribution** (and,
optionally, invoices). Neon meters; it does not bill — ✅ (2-0) the Agent Plan punts billing
orchestration; 🟡 the Consumption API returns raw values only.

**The gap (builder-only knowledge).** Your **pricing model**, your **tenant↔customer** mapping, your
**margin targets**. Neon can't know what you charge or who a project belongs to.

**Capabilities:**

- Ingest the **Consumption API** (per-project + beta per-branch) — TenantForge already has a Neon
  **usage provider** adapter; extend it to pull cost-relevant metrics across the fleet.
- Map **project → tenant → customer** via the existing registry (the piece generic billing tools lack).
- Apply the operator's pricing model → **per-tenant cost, revenue, and margin**; flag
  **unprofitable tenants** and attribute **scale-to-zero savings**.
- Optional: emit Stripe line items / invoices (write path — higher stakes).

**Reuses:** the Neon usage-provider adapter, the registry (project→tenant), lifecycle (active set),
webhooks (usage/overage alerts), audit, all four entrypoints.

**Defensibility (adversarial — this is the weaker moat).** Generic OSS billing engines
(stripemeter/meteroid/flexprice) could add a Neon adapter; Neon could ship billing exports. It's
integration glue. The stickier, more-defensible slice is **cost/margin attribution** (not invoicing)
— "which tenants cost more than they pay" — because it fuses Neon's cost data with _your_ pricing,
which neither Neon nor a generic billing tool has.

**Fee-kill / immediately-useful.** Directly protects margin for a bootstrapped founder and avoids
buying a billing platform early. The cost-attribution view is useful on day one with zero write-side risk.

**Smallest first slice (MVP).** A read-only `cost-report` command: pull consumption per tenant
project → map via registry → show Neon cost (published rates) vs. configured price → **margin per
tenant**. No Stripe writes. Cheap, immediately useful, reuses the usage provider.

**Risks.** Money is high-stakes — keep the write/invoicing path out of the MVP. Neon's pricing
changes (don't hardcode). Don't rebuild metering (it's native); only the **attribution + pricing**
layer is yours.

---

## 5. Recommendation

- **Lead with #1 (compliance evidence layer).** Strongest moat (policy+proof, builder-only), highest
  reuse of already-built+tested code, squarely in space Neon won't absorb.
- **Attach #3 as a read-only cost/margin report** — cheap (reuses the usage provider), immediately
  useful, and the strongest _fee-kill_ story; defer billing/invoicing (write path, weak moat, high stakes).
- Treat **#2 (drift/reconciliation)** as the natural follow-on (reuses the drift asset).

Net repositioning: TenantForge becomes the **application/governance plane over a Neon db-per-tenant
fleet** — routing + compliance evidence + cost attribution + drift — explicitly _not_ a
re-implementation of provisioning, metering, migration-execution, or backups, all of which Neon owns.
