# Contributing

Thanks for your interest! This repo is a collection of standalone tools built on
[Neon](https://neon.com) (serverless Postgres). The lead tool is
[`vectornest/`](./vectornest/); each tool lives in its own top-level directory.

## Prerequisites

- **Node ≥ 22** and **pnpm** (the repo is a pnpm workspace; version is pinned via
  `packageManager` in the root `package.json` — `corepack enable pnpm` will provision it).
- A **Neon** database and an **OpenAI-compatible embeddings** endpoint to run a tool locally or its
  integration tests (see the tool's README, e.g. [`vectornest/README.md`](./vectornest/README.md)).

## Setup

```bash
pnpm install
cp vectornest/.env.example vectornest/.env   # fill in for local runs (git-ignored; never commit it)
```

## Local checks (run before pushing)

From the repo root (runs across the workspace):

```bash
pnpm lint        # eslint (type-checked) + prettier
pnpm typecheck   # tsc --noEmit, strict
pnpm test        # vitest unit suite + coverage gates (hermetic; no network)
```

Integration tests hit live services and self-skip without credentials:

```bash
pnpm --filter vectornest test:int   # needs DATABASE_URL + EMBEDDINGS_* (+ NEON_API_* for rehearsal)
```

CI runs the same gates plus **CodeQL (SAST)**, **dependency audit (SCA)**, and **gitleaks
(secret-scan)** — see [`.github/workflows/`](./.github/workflows).

## Workflow

Trunk-based development with short-lived branches. **`main` is protected** — no direct pushes.

1. Branch off `main`: `type/short-description` (e.g. `feat/oauth-pkce`, `fix/null-deref`).
2. Make focused, atomic commits using
   [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`
   (`feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`, `ci`, `perf`, `security`).
3. **Sign your commits** (GPG or SSH) — signature verification is **enforced** on `main`.
4. Open a PR to `main`. State what/why, risk, and test evidence.
5. All required checks must pass: **`quality`** (lint/type/test/SCA) · **`secret-scan`** ·
   **`CodeQL`**. Branches must be up to date with `main`.
6. Merge by **squash or rebase** (linear history is required — no merge commits).

## Standards

- **Tests are part of "done":** ≥ 90% line + branch coverage, **100% on critical paths** (the pure
  core). Add a regression test for every bug fixed.
- **Architecture:** keep pure logic (the functional core) free of I/O; put I/O behind injected
  ports/adapters. See a tool's `ARCHITECTURE.md`.
- **Docs:** document every public symbol (TSDoc — lint-enforced) and update the relevant
  README/docs in the same PR.
- **Security by default:** validate input at boundaries, parameterize all SQL, never commit secrets,
  treat external/model output as untrusted. The repo inherits a Secure SDLC ruleset via
  [`CLAUDE.md`](./CLAUDE.md) files.
- **Dependencies:** pin them; CI pins GitHub Actions by commit SHA. Vet new dependencies before
  adding.

## New tools

Each tool is standalone and discoverable: it carries its own `README.md`, `CLAUDE.md`, and a
`neon-tool.json` manifest. See [`TOOLS.md`](./TOOLS.md) for the discovery convention.

## Reporting security issues

Do **not** open public issues for vulnerabilities — see [`SECURITY.md`](./SECURITY.md).
