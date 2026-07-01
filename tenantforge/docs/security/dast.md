# DAST — Dynamic Application Security Testing

TenantForge runs a **dynamic** security scan against a _running_ instance of the HTTP
control-plane API, as the DAST half of the CI security gates (gap #18). It complements the
**static** gates — SAST/SCA/secret-scan/IaC (`.github/workflows/ci.yml`) and CodeQL
(`.github/workflows/codeql.yml`) — by exercising the deployed surface that static analysis
can't see.

Workflow: [`.github/workflows/tenantforge-dast.yml`](../../../.github/workflows/tenantforge-dast.yml).
Scanner: **OWASP ZAP baseline** ([`zaproxy/action-baseline`](https://github.com/zaproxy/action-baseline),
image `ghcr.io/zaproxy/zaproxy:stable`), pinned by commit SHA.

## What it scans

The job spins up an **ephemeral, throwaway Postgres** service (never a real/prod DB — it holds
only disposable control-plane metadata), applies the registry migrations, boots the Hono HTTP
API, waits for `GET /health` to return 200, then points ZAP at `http://127.0.0.1:3000`.

ZAP baseline is a **largely-passive** scan: it spiders the app and passively analyses the
responses. It does **not** actively fuzz, inject, or brute-force. Because the scan runs
**unauthenticated** (no bearer token is supplied), it reaches:

- `GET /health` — static liveness probe.
- `GET /ready` — readiness probe (registry connectivity).
- `GET /metrics` — Prometheus exposition (unauthenticated by default).
- the `/v1/*` control-plane routes — which return **401** unauthenticated (the auth wall).

So the scan validates the deployed-surface properties static analysis misses:

- the `secureHeaders()` middleware config (CSP, `X-Content-Type-Options`, `Referrer-Policy`,
  HSTS/frame-ancestors, etc.),
- that **error and 401 responses leak no internals** (stack traces, SQL, framework detail —
  `std-owasp-proactive` #10),
- cookie flags and `Cache-Control` on any sensitive response,
- reflected-input handling on the routes ZAP can reach.

## Gate policy — fail on high-risk (FAIL) only

The job **fails on ZAP high-risk (FAIL) alerts only**; WARN-level passive findings are surfaced
in the uploaded report but do **not** block the build. This is deliberate: a baseline is largely
advisory, so blocking on every passive WARN would be noise and would push people to disable the
gate. High-risk classes (injection, reflected/persistent XSS) are escalated to FAIL.

Per-rule thresholds are tuned in
[`tenantforge/scripts/zap-baseline-rules.tsv`](../../scripts/zap-baseline-rules.tsv)
(tab-separated `pluginId<TAB>action`, where action ∈ PASS/IGNORE/INFO/WARN/FAIL). Loosening a `FAIL`→`WARN` or adding an
`IGNORE` is **relaxing a security gate** (`@rules/workflow-gated-actions.md`) and an accepted,
owned, time-boxed risk (`@rules/workflow-cve-management.md`) — review it in the PR.

The action is configured with `allow_issue_writing: false`, so it files **no** GitHub issue and
the workflow keeps `permissions: contents: read` (no `issues: write`). The findings live in the
uploaded **`tenantforge-zap-baseline-report`** artifact (HTML/JSON/Markdown). The server's stderr
is uploaded as **`tenantforge-dast-server-log`** for triage.

## When it runs

- **`pull_request` → main** — a merge-blocking gate on every PR.
- **`workflow_dispatch`** — on demand (e.g. after changing the HTTP surface).
- **`schedule`** — weekly re-scan of `main` so drift surfaces even without a PR
  (a passing gate you never re-run silently rots).

## Running it

### Via GitHub (dispatch)

Actions → **TenantForge DAST (ZAP baseline)** → **Run workflow**.

### Locally

You need Docker (or Podman) for the ZAP image and a throwaway Postgres. Roughly:

```bash
# 1. Ephemeral Postgres (throwaway — no tenant data).
docker run --rm -d --name tf-dast-pg -p 5432:5432 \
  -e POSTGRES_USER=tenantforge -e POSTGRES_PASSWORD=tenantforge -e POSTGRES_DB=tenantforge \
  postgres:17-alpine

# 2. Boot the API against it (staging = non-prod; throwaway secrets; insecure DB for loopback).
export DATABASE_URL='postgres://tenantforge:tenantforge@127.0.0.1:5432/tenantforge'
export TENANTFORGE_ALLOW_INSECURE_DB=true TENANTFORGE_ENV=staging
export TENANTFORGE_SECRET_KEY='dast-throwaway-secret-key-0000'
export TENANTFORGE_HTTP_TOKEN='dast-throwaway-http-token-0000'
export NEON_API_KEY='dast-dummy-neon-api-key' NEON_ORG_ID='dast-dummy-neon-org'
export TENANTFORGE_PORT=3000
pnpm --filter tenantforge cli migrate
pnpm --filter tenantforge http &
./tenantforge/scripts/wait-for-health.sh http://127.0.0.1:3000/health 90 2

# 3. Run the ZAP baseline (same image the action uses).
docker run --rm --network host -v "$(pwd)/tenantforge/scripts:/zap/wrk:ro" \
  ghcr.io/zaproxy/zaproxy:stable \
  zap-baseline.py -t http://127.0.0.1:3000 -c zap-baseline-rules.tsv -T 5
# exit code: 0 = clean/WARN-only, non-zero = a FAIL-level alert (matches the CI gate).
```

## Boot environment (why each var)

The API **requires a live Postgres at boot** (`tenantForgeFromConfig` connects `DATABASE_URL`
for the registry) and validates its whole config at startup (fail-fast — `src/app/config.ts`).
The scan sets the minimum to boot; none of it is a real secret or reaches production:

| Variable                             | Why                                                                                                                                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                       | The ephemeral service DSN — the control-plane registry (metadata only).                                                                                                                 |
| `TENANTFORGE_ALLOW_INSECURE_DB=true` | The loopback service has no TLS cert; config fails closed on a non-`sslmode=require` DSN by default. Local scan only — **never** in prod.                                               |
| `TENANTFORGE_ENV=staging`            | Non-prod context — avoids the production-only fail-fast (real erasure/compliance signing keys, a `pg` evidence store) a passive scan doesn't need.                                      |
| `TENANTFORGE_SECRET_KEY`             | The default `neon-pg` secret backend requires this AES key (≥16 chars). Throwaway.                                                                                                      |
| `TENANTFORGE_HTTP_TOKEN`             | The entrypoint fails closed without a way to authenticate. Throwaway; **the scan does not use it** (unauthenticated) — it only lets the server boot.                                    |
| `NEON_API_KEY` / `NEON_ORG_ID`       | Gate config parsing (`min(1)` strings). **Not contacted** during a passive scan — the Neon client connects lazily, per provisioning request, and no provisioning happens. Dummy values. |
| `TENANTFORGE_PORT=3000`              | The fixed port the server binds and ZAP targets.                                                                                                                                        |

## Future enhancement — authenticated deep-fuzzing

This is a **passive baseline**: it does not authenticate, so it can't exercise the authorized
`/v1/*` behaviour (BOLA/BFLA checks, request-body validation, mass-assignment). A natural next
step is **authenticated, contract-driven fuzzing** — e.g.
[schemathesis](https://schemathesis.readthedocs.io/) driven by
[`tenantforge/openapi.yaml`](../../openapi.yaml) with a bearer token — to fuzz every documented
operation against its schema, plus a ZAP **full** (active) scan of an isolated instance. Both
would run against the same ephemeral, throwaway stack (never prod), gated the same fail-closed way.
