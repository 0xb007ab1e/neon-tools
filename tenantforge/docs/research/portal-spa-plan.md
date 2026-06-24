# TenantForge — Customer Portal SPA + Self-Serve Endpoints (plan)

> **Status: plan draft (2026-06-24).** Turns the customer-facing portal from a read-only,
> server-rendered page into a React SPA with self-serve account actions, mirroring the signup +
> dashboard SPA pattern. Decisions below are **settled** (owner-confirmed). Nothing here is
> implemented yet; `main` is unaffected until the feature branches land.
>
> **Why now:** the operator dashboard is feature-complete (14 panels) and the signup SPA just
> shipped (Phase 3). The customer portal is the laggard external surface — still server-rendered
> HTML (`src/app/portal.ts`) exposing only 5 read endpoints (`me, usage, charges, receipts,
refunds`). Several capabilities exist in the backend/operator side but aren't exposed to the
> customer.

## Settled decisions

1. **Cancel & erasure = self-serve** (not operator-request). Cancel is a self-serve **offboard**
   (reversible — the Neon project is retained/scaled-to-zero until purge, so there's a natural
   grace window). Erasure is **self-serve but hard-gated**: irreversible, so it requires a typed
   confirmation **and** step-up re-authentication, runs the existing verified-erasure engine
   (export → delete project → crypto-shred key → signed certificate), and emits the certificate
   back to the customer. Self-serve does **not** mean one-click — see the gating table.
2. **Auth = OIDC.** The SPA targets the OIDC `TenantAuthenticator` adapter (`feat/portal-oidc`,
   already merged) as the production login — a JWT whose claim carries the tenant id, exchanged for
   the portal session cookie. The static-token adapter remains for dev/tests only.
3. **Scope = all five action areas in v1:** payment-method update, plan change, invoices/billing,
   cancel, and data export + erasure.

## What exists vs. what's new

**Reuse (already in the `TenantForge` facade):** `tenantSummary`, `usage`,
`tenantCharges/Refunds/Notifications`, `previewPlanChange(id,…)`, `changePlan(id, newPriceUsd,
opts)`, `invoice(id, period)`, `exportTenantData(id)`, `erase(id)`, `offboard(id)`,
`creditBalance`. The portal's anti-BOLA pattern is already correct — tenant id derives only from
the signed session, never from client input.

**Add (new facade methods / wiring):**

- `tenantPaymentSetup(tenantId)` — a Stripe SetupIntent for an **existing tenant's**
  `billingCustomerRef` + set the resulting card as default (today `createPaymentSetup` is keyed by
  **signupId** only). Reuses the `PaymentSetup` port and Stripe adapter; no new adapter.
- a per-tenant **invoice list** (invoices generate on-demand today; add a "recent invoices" read).
- tenant-scoped **cancel** / **export** / **erasure-request** wrappers over `offboard` /
  `exportTenantData` / `erase`, scoped to the session tenant, with the gating below.

## The deliberate policy change (threat-modeled in Phase 0)

`portal.ts` today states _"Read-only: no money movement or lifecycle actions (those stay
operator/CLI)"_, and ADR-0004 keeps money/secret ops off the agent + dashboard surfaces. This
feature **relaxes that for the customer's own account only**, behind explicit gating:

| Action                         | Risk                    | Gating                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| View invoices / usage / credit | low                     | read-only; existing session-scoped pattern                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Update payment method          | medium (money-adjacent) | session + CSRF + rate-limit + idempotency; Stripe Elements; server verifies the SetupIntent before set-default                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Change plan                    | medium (billing)        | preview → explicit confirm → idempotent `changePlan`; audited                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Cancel (offboard)              | high but **reversible** | typed confirmation + **control-plane second-factor** (one-time email/TOTP code, single-use, short TTL — F1); calls `offboard` (project retained, grace period) — **never** `purge`                                                                                                                                                                                                                                                                                                                                                                                                 |
| Data export (DSAR)             | low/medium              | rate-limited + per-tenant cooldown / max-in-flight; tenant-scoped export location (F7)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Erasure                        | **irreversible**        | typed confirmation **+ control-plane second-factor** (one-time email/TOTP, not IdP `auth_time` — F1); **mandatory undo window** (async-with-cancel — request scheduled, project NOT deleted synchronously; tenant **keeps serving** during the window; customer can cancel until it elapses — F2); a **single atomic conditional flip** (`UPDATE … WHERE status='pending'`) gates execution so a redelivered/raced command can't delete after a successful cancel; only the winner runs the verified-erasure engine → signed certificate; audited + **operator/tenant alert** (F7) |

Cross-cutting controls on every mutation: **CSRF token** (cookie-auth + state-changing POST needs
more than `SameSite=Strict`), **per-IP/per-session rate limiting** (reuse `rateLimitStore`),
**idempotency keys** on money ops (reuse `idempotency-store`), zod body validation, and an
`observe(...)` **audit event** with the tenant principal as actor (redacted).

## Phasing

### Phase 0 — Design & threat model (no code)

STRIDE the portal's new write boundary (`workflow-threat-model`); record the decided gating in a
`docs/security/threat-model.md` addendum. Confirm the OIDC login/session exchange shape and the
step-up re-auth mechanism for cancel/erasure.

### Phase 0 — outcomes (resolved 2026-06-24)

Threat model recorded as **B8w** (write surface) in `docs/security/threat-model.md` with per-action
gating + planned abuse cases. Two design points settled:

- **OIDC login / session exchange.** The merged `oidc-tenant-authenticator.ts` already verifies a
  Bearer JWT (jose; `iss`/`aud`/`exp`, JWKS, asym-alg allow-list) → `TenantPrincipal{ tenantId }`.
  Shape: the SPA runs **Authorization Code + PKCE** with the IdP, obtains the JWT, and POSTs it to
  the portal login endpoint; `authenticator.authenticate(jwt)` verifies and the portal mints the
  existing signed/HttpOnly/`SameSite=Strict` session cookie. No new adapter needed.
- **Step-up = control-plane second factor (RULED — F1).** The red-team showed IdP `auth_time`/`iat`
  recency is **not** proof of a fresh human gesture (a standard IdP mints a "fresh" token via silent
  refresh / `prompt=none`). So step-up for cancel + erasure is a **control-plane-owned** one-time
  factor — a single-use, short-TTL code delivered by **email/TOTP**, verified server-side — entirely
  independent of the OIDC token. (OIDC remains the _login_; this is an additional gate on the two
  destructive actions.) Needs a one-time-code store + the existing notifier (email).
- **Undo-window data model (RULED — F2).** A pending-erasure record (tenant id, requested-at,
  execute-at, status `pending|processing|cancelled|done`). **The tenant keeps serving during the
  window** (pending-erasure does NOT suspend routing — avoids a timer-delayed self-serve DoS). A
  scheduled executor (queue command / retention-style sweep) runs the verified-erasure engine only
  after `execute-at`, guarded by a **single atomic conditional update** (`UPDATE … SET
status='processing' WHERE id=? AND status='pending'` → proceed only if it won the row). Customer
  `POST /api/erasure/cancel` is the same atomic flip (`pending → cancelled`). Executor is idempotent
  across at-least-once redelivery: a command for a non-`pending` record acks and exits — never
  re-exports/re-deletes (fixes the TOCTOU + double-run the red-team found).
- **Default window** = 48h (configurable); **window + execution ≤ statutory erasure SLA** (GDPR Art.17
  "without undue delay") — documented, and the undo window must not push total time past the SLA.

### Phase 0 — red-team review (verdict: escalated → ruled; required revisions)

Design red-teamed 2026-06-24. Core upheld (the BOLA/self-scoping invariant is architecturally sound,
so the ADR-0004 worry is well-handled). Two cruxes escalated and **ruled by owner**; the rest are
required revisions folded in:

- **F1 (HIGH) — step-up.** RULED: **control-plane second factor** (email/TOTP one-time code), not IdP
  `auth_time`. See Phase 0 outcomes above.
- **F2 (HIGH) — undo window.** RULED: **keep serving** during the window + **atomic** cancel/execute +
  idempotent executor. See above.
- **F3 (MED/HIGH) — money/lifecycle integrity.** (a) Wrap `changePlan` and payment set-default in the
  **idempotency store** at the _endpoint_ level (client `Idempotency-Key`), covering metadata write +
  settlement + audit — today only the PSP charge key is idempotent. (b) Make the downgrade-refund
  branch an atomic guard (no double-refund on concurrent downgrades). (c) Define **cancel's billing
  semantics**: exclude `offboarding` from billing/dunning sweeps (verify + test) so a cancelled tenant
  isn't charged/dunned. (d) "Reversible cancel" is only _operator_-reversible after the retention
  window — either add a **self-serve restore within the window** or rename the action to not
  over-promise; tell the customer the deadline.
- **F4 (MED) — CSRF/OIDC.** Signed **per-session CSRF token required in a custom header** on every
  mutation (not bare double-submit) + `Origin`/`Sec-Fetch-Site` allow-list; pin the OIDC
  **`state`+`nonce` server-side** and verify at the login callback (login POST is itself CSRF-able).
- **F5 (MED) — PSP-side BOLA.** Before set-default, verify `intent.customerRef ===
tenant.billingCustomerRef` (mirror `completeSignup`); fail closed when the tenant has no billing
  customer. Abuse test: a SetupIntent for customer X can't be applied to tenant Y.
- **F6 (MED) — rollout.** RULED: **all five in v1 scope, but cancel + erasure behind a feature flag
  that ships OFF** until F1 + F2 have green abuse tests + security review. Payment/plan/invoices/export
  go live first; flip the destructive pair when proven (`topic-config-environments` — decouple deploy
  from release).
- **F7 (LOW/MED) — audit/export.** Per-tenant export cooldown + max-in-flight; tenant-scoped (non-
  guessable) export location; **alert operator (and the tenant's verified email)** on every self-serve
  cancel/erasure (griefing tripwire + wrong-account safety net).
- **Process — new ADR.** The ADR-0004 relaxation is recorded as its own **ADR-0010** (amends 0004),
  not only this plan note.

### Phase 1 — Self-serve JSON endpoints (backend; shippable independently)

Grow `createPortal`, copying the **signup sub-app's** security scaffolding (it already has per-IP
`rateLimitStore`, zod `read()` validation, `statusFor` error mapping):

- `GET /api/plan`, `POST /api/plan/preview`, `POST /api/plan/change`
- `POST /api/payment-method/setup-intent` (+ confirm/set-default) — new facade method
- `GET /api/invoices`, `GET /api/credit-balance`
- `POST /api/cancel` (confirmed offboard), `POST /api/data-export`, `POST /api/erasure` (step-up)
- CSRF token issuance/verification; rate limiting; idempotency; audit emit per mutation.

### Phase 2 — Portal React SPA

New `tenantforge/portal/` dir mirroring `signup/` (`App.tsx`, `api.ts`, `loaders.ts`, `main.tsx`,
`styles.css`, `vite.config.ts` with `base: '/portal/'`, dev proxy `/portal/api` → `:3000`;
`portal:dev`/`portal:build` scripts; add to root `build`/`typecheck`). `createPortal` grows a
`staticRoot` + **scoped CSP allowing Stripe.js** (as `createSignup` does) + SPA `index.html`
fallback, keeping the JSON `/api/*` endpoints. OIDC login flow wired to the session exchange.
Views: **Overview** (account + usage), **Billing** (invoices/charges/refunds/receipts/credit),
**Plan** (preview + change), **Payment method** (Stripe Elements), **Danger zone** (cancel,
export, erasure). WCAG 2.2 AA: semantic HTML, keyboard operability, focus management on
route/modal changes, `prefers-reduced-motion` / `prefers-color-scheme`. Server-rendered page kept
as a no-JS fallback or retired deliberately.

### Phase 3 — Tests, a11y, docs (the gate)

- **Unit** (pure core for new logic), **integration** (extend `test/app/portal.test.ts` per
  endpoint), **contract** (add endpoints to `openapi.yaml` + the OpenAPI contract test),
  **abuse/negative** (another tenant's IDs → denied; missing/invalid CSRF; unauth; idempotency
  replay; step-up bypass attempts).
- **a11y**: axe in the SPA test + manual keyboard/screen-reader pass.
- **Docs**: `openapi.yaml`, `CHANGELOG` (MINOR — additive), customer cancel/erasure runbook note,
  dashboard-parity note.
- Coverage gates: **100%** on the new payment + authz/erasure paths, **≥90%** elsewhere.

## Delivery & sequencing

Three stacked PRs: `portal-selfserve-api` → `portal-spa` → `portal-tests-docs`. Per the
stacked-PR workflow (signed commits force squash; rebase children `--onto main` bottom-up; never
`--delete-branch` a stacked base; CI only fires on PRs→main), squash-merge each then rebase the
next. All gated actions (commit / push / PR / deploy) stop for human approval.

## Risks / watch items

- **Self-serve erasure is irreversible** — **HARD REQUIREMENT:** a mandatory undo window
  (async-with-cancel). The erasure request is scheduled, NOT executed synchronously; the project is
  deleted only after the window elapses, and the customer can cancel the pending request until then.
  Typed confirm + step-up re-auth gate the _request_; the window guards the _execution_.
- **Money paths** (payment-method, plan change) — idempotency + server-side SetupIntent
  verification are mandatory; never trust the client that a card succeeded.
- **OIDC session exchange** is a trust boundary — validate `iss`/`aud`/`exp`, pin the algorithm,
  map the tenant claim server-side only.
