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
only disposable control-plane metadata), **builds the three SPAs** (`dashboard`, `portal`,
`signup`), applies the registry migrations, boots the Hono HTTP API **with all four surfaces
mounted**, waits for `GET /health` to return 200 (and asserts each sub-app returns `200` HTML —
a `404` would mean its mount guard wasn't satisfied and fails the job), then points ZAP at
`http://127.0.0.1:3000`.

ZAP baseline is a **largely-passive** scan: it spiders the app and passively analyses the
responses. It does **not** actively fuzz, inject, or brute-force. No **API bearer token** is
supplied, so the `/v1/*` control-plane routes stay behind their **401** wall — but the three
customer-facing SPAs **are** mounted (each is gated on its own session secret + more; the job
sets throwaway/public test values for exactly those guards), so ZAP spiders their real pages,
assets, and response headers. The scan reaches all four surfaces:

- **Probes + API:**
  - `GET /health` — static liveness probe.
  - `GET /ready` — readiness probe (registry connectivity).
  - `GET /metrics` — Prometheus exposition (unauthenticated by default).
  - the `/v1/*` control-plane routes — which return **401** unauthenticated (the auth wall).
- **`/dashboard/`** — the operator dashboard SPA (cookie-session auth; served static HTML +
  assets). Mounted by `TENANTFORGE_DASHBOARD_SECRET`.
- **`/portal/`** — the tenant self-serve portal SPA (its own cookie session; **Stripe-relaxed
  CSP** allowing `js.stripe.com`). Mounted by `TENANTFORGE_PORTAL_SECRET` + a token-mode tenant
  authenticator.
- **`/signup/`** — the public payment-gated signup SPA (**CSP additionally relaxed for Cloudflare
  Turnstile** — `challenges.cloudflare.com`). Mounted by `TENANTFORGE_SIGNUP_SECRET` + the public
  Stripe publishable key + the captcha site key (with Stripe + a notifier, per the config's
  fail-closed signup requirements).

So the scan validates the deployed-surface properties static analysis misses — now across **all
four** surfaces, not just the API wall:

- the `secureHeaders()` middleware config **and the per-SPA scoped CSPs** (the Stripe/Turnstile
  `script-src`/`frame-src`/`connect-src` allow-lists, `X-Content-Type-Options`, `Referrer-Policy`,
  `X-Frame-Options`/frame-ancestors, HSTS),
- that **error and 401 responses leak no internals** (stack traces, SQL, framework detail —
  `std-owasp-proactive` #10),
- cookie flags and `Cache-Control` on the SPA + any sensitive response,
- reflected-input handling on the routes ZAP can reach.

> **Why the sub-apps weren't scanned before (gap #3):** each SPA sub-app mounts only when its
> guards are set (see `src/app/http-server.ts` — dashboard needs a session secret; the portal
> needs a session secret **and** a tenant authenticator; signup needs a session secret **and** the
> public Stripe/captcha keys). The original DAST job set only `TENANTFORGE_HTTP_TOKEN`, so none of
> them mounted and ZAP only ever reached the probes + the `/v1/*` 401 wall — the SPA hardening the
> gate is meant to prove was never exercised. This job now sets those throwaway guard values so all
> three mount and get scanned.

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

# 2. Build the three SPAs so the sub-apps serve real HTML for ZAP to spider.
pnpm --filter tenantforge dashboard:build
pnpm --filter tenantforge portal:build
pnpm --filter tenantforge signup:build

# 3. Boot the API against it (staging = non-prod; throwaway secrets; insecure DB for loopback),
#    with all three SPAs mounted (each gated on its own secret + more — throwaway/public values).
export DATABASE_URL='postgres://tenantforge:tenantforge@127.0.0.1:5432/tenantforge'
export TENANTFORGE_ALLOW_INSECURE_DB=true TENANTFORGE_ENV=staging
export TENANTFORGE_SECRET_KEY='dast-throwaway-secret-key-0000'
export TENANTFORGE_HTTP_TOKEN='dast-throwaway-http-token-0000'
export NEON_API_KEY='dast-dummy-neon-api-key' NEON_ORG_ID='dast-dummy-neon-org'
export TENANTFORGE_PORT=3000
# Dashboard (session secret >=32 ⇒ /dashboard mounts) + its built dist.
export TENANTFORGE_DASHBOARD_SECRET='dast-throwaway-dashboard-session-000'
export TENANTFORGE_DASHBOARD_DIST="$(pwd)/tenantforge/dashboard/dist"
# Portal (session secret >=32 + a token-mode tenant authenticator) + its built dist.
export TENANTFORGE_PORTAL_SECRET='dast-throwaway-portal-session-000000'
export TENANTFORGE_PORTAL_AUTH_MODE=token
export TENANTFORGE_PORTAL_CREDENTIALS='dast-tenant:dast-throwaway-portal-token-0000'
export TENANTFORGE_PORTAL_DIST="$(pwd)/tenantforge/portal/dist"
# Signup (session secret >=32) — enabling signup fails closed unless Stripe + captcha + notifier
# are all set; the Stripe pk + captcha site key also satisfy the signup mount guard. Public test values.
export TENANTFORGE_SIGNUP_SECRET='dast-throwaway-signup-session-000000'
export TENANTFORGE_SIGNUP_DIST="$(pwd)/tenantforge/signup/dist"
export TENANTFORGE_PAYMENT_GATEWAY=stripe
export STRIPE_PUBLISHABLE_KEY='pk_test_dast_throwaway_publishable_0000'
export STRIPE_SECRET_KEY='sk_test_dast_throwaway_secret_0000'
export TENANTFORGE_CAPTCHA_PROVIDER=turnstile
export TENANTFORGE_CAPTCHA_SITE_KEY='1x00000000000000000000AA'   # Cloudflare Turnstile test site key
export TENANTFORGE_CAPTCHA_SECRET='1x0000000000000000000000000000000AA'  # Turnstile test secret
export TENANTFORGE_NOTIFIER=log
pnpm --filter tenantforge cli migrate
pnpm --filter tenantforge http &
./tenantforge/scripts/wait-for-health.sh http://127.0.0.1:3000/health 90 2
# Sanity: each sub-app should return 200 HTML (a 404 = its mount guard wasn't satisfied).
for p in /dashboard/ /portal/ /signup/; do curl -sf -o /dev/null "http://127.0.0.1:3000$p" && echo "$p mounted"; done

# 4. Run the ZAP baseline (same image the action uses).
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

### Sub-app mount vars (so ZAP scans the three SPAs — gap #3)

Each SPA sub-app mounts only when its guards are set (`src/app/http-server.ts`). These throwaway/
public test values satisfy exactly those guards so ZAP reaches the dashboard, portal, and signup:

| Variable                                                                | Satisfies which mount guard                                                                                                                             |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TENANTFORGE_DASHBOARD_SECRET` (≥32)                                    | `options.dashboardSecret` ⇒ **`/dashboard`** mounts. Session/CSRF HMAC key — the `min(32)` floor (gap #8) applies.                                      |
| `TENANTFORGE_DASHBOARD_DIST`                                            | Static root ⇒ the dashboard serves its built `dist/` HTML (else JSON API only).                                                                         |
| `TENANTFORGE_PORTAL_SECRET` (≥32)                                       | `options.portalSecret` — half of the **`/portal`** guard (needs a tenant authenticator too). Session/CSRF HMAC key (`min(32)`).                         |
| `TENANTFORGE_PORTAL_AUTH_MODE=token` + `TENANTFORGE_PORTAL_CREDENTIALS` | Token mode builds `tenantAuthenticator` from the `tenantId:token` map — the other half of the `/portal` guard.                                          |
| `TENANTFORGE_PORTAL_DIST`                                               | Static root ⇒ the portal serves its built `dist/` (Stripe-relaxed CSP).                                                                                 |
| `TENANTFORGE_SIGNUP_SECRET` (≥32)                                       | `options.signupSecret` — part of the **`/signup`** guard. Session HMAC key (`min(32)`). **Enabling signup fails closed** unless the rest below are set. |
| `TENANTFORGE_PAYMENT_GATEWAY=stripe` + `STRIPE_SECRET_KEY`              | Signup requires the Stripe gateway; the secret key is required whenever the gateway is `stripe`. Public **test-mode** placeholder — no charge.          |
| `STRIPE_PUBLISHABLE_KEY` (`pk_test_…`)                                  | `options.signupPublishableKey` (public browser key) — part of the `/signup` guard. Stripe test-mode value.                                              |
| `TENANTFORGE_CAPTCHA_PROVIDER=turnstile` + `TENANTFORGE_CAPTCHA_SECRET` | Signup requires a captcha; the secret backs server-side siteverify. Cloudflare **Turnstile test** secret (always passes).                               |
| `TENANTFORGE_CAPTCHA_SITE_KEY` (`1x…`)                                  | `options.signupCaptchaSiteKey` (public widget key) — part of the `/signup` guard. Turnstile **test** site key.                                          |
| `TENANTFORGE_NOTIFIER=log`                                              | Signup requires a notifier (email verification); `log` sends nothing (audit-only) — no outbound email during the scan.                                  |
| `TENANTFORGE_SIGNUP_DIST`                                               | Static root ⇒ the signup serves its built `dist/` (Turnstile-relaxed CSP).                                                                              |

The `*_DIST` paths point at each SPA's built `dist/` (produced by the `dashboard/portal/signup:build`
steps). The boot step asserts each of `/dashboard/`, `/portal/`, `/signup/` returns `200` after
health — a `404` means a guard wasn't satisfied and **fails the job** (fail-closed; the regression
gap #3 fixes).

## Future enhancement — authenticated deep-fuzzing

The four surfaces (probes + `/v1/*` API, dashboard, portal, signup) are now **mounted and passively
scanned**. What remains a **passive baseline** is that ZAP still does not **authenticate to the
API**, so it can't exercise the authorized `/v1/*` behaviour (BOLA/BFLA checks, request-body
validation, mass-assignment). A natural next step is **authenticated, contract-driven fuzzing** —
e.g. [schemathesis](https://schemathesis.readthedocs.io/) driven by
[`tenantforge/openapi.yaml`](../../openapi.yaml) with a bearer token — to fuzz every documented
operation against its schema, plus a ZAP **full** (active) scan of an isolated instance. Both would
run against the same ephemeral, throwaway stack (never prod), gated the same fail-closed way.
