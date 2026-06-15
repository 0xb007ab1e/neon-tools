# Neon Projects Collection

A collection of products designed to operate on **[Neon](https://neon.com/docs/introduction)** —
serverless Postgres with scale-to-zero, copy-on-write branching, and instant API provisioning.

## Purpose

Identify, validate, and (eventually) build products whose core value is **reducing,
alleviating, or eliminating fees and operational overhead** by exploiting Neon's economics —
with the goal of submitting one or more to **[Neon's Startup Program](https://neon.com/startups)**
for inclusion in their credits program (up to $100K over 12 months).

## Status

**Research phase.** No application code yet — see [`research/`](./research/) for the current
analysis. Product build-out begins once a direction (or directions) is chosen.

## The core thesis

> Neon drives the marginal cost of an **idle, ephemeral, or duplicated** Postgres database
> toward **zero**, and turns "provision a database" into a **millisecond API call**.
>
> Every product opportunity here is the same shape: find a market where incumbents force
> customers to pay for **always-on, over-provisioned, or duplicated** database capacity —
> and undercut it to near-zero using **scale-to-zero + branching + instant provisioning**.

## Contents

- [`research/`](./research/) — the analysis trail: capabilities & economics
  ([`neon-research.md`](./research/neon-research.md)), 30 ranked concepts
  ([`product-concepts.md`](./research/product-concepts.md)), the scoring/convergence pass
  ([`scoring.md`](./research/scoring.md)), and the finalist teardown
  ([`teardown-finalists.md`](./research/teardown-finalists.md)).
- [`TOOLS.md`](./TOOLS.md) — registry of the standalone tools + the discovery convention.
- [`tool-manifest.schema.json`](./tool-manifest.schema.json) — schema every tool's `neon-tool.json` follows.
- **Tool directories** (one per tool): [`vectornest/`](./vectornest/) — the first build.

## Tools & discovery

Each unique tool lives in **its own subdirectory** under this root, is **standalone** (own
`README`, `CLAUDE.md`, manifest, and eventually its own package), and is **discoverable** by
harnesses/agents via a `neon-tool.json` manifest at its directory root. Discover by globbing
`**/neon-tool.json`; invoke via the manifest's `entrypoints` (library / CLI / HTTP / MCP); compose
via `provides`/`consumes` capability tokens. Full convention + schema: [`TOOLS.md`](./TOOLS.md).

Tools are built one at a time as independent units and later **composed into a full SaaS** (the
likely shell is TenantForge — a DB-per-tenant control plane — embedding the other tools per tenant).

## Conventions

This collection inherits the user's global SSDLC ruleset. Each tool's subdirectory carries a
stack-appropriate `CLAUDE.md` (most are TypeScript/Node services calling the Neon API, base
`templates/typescript-service.md`). Secrets come from env only (`.env` git-ignored,
`.env.example` committed).
