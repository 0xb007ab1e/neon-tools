# Runbook: Customer Portal Self-Serve Cancel & Erasure

> Operational procedure for the customer self-serve **destructive** actions — **cancel** (offboard)
> and **erasure** (GDPR Art. 17) — and the scheduled **erasure executor sweep** that runs them.
> Rules: `@rules/workflow-runbooks.md`, `@rules/std-privacy.md`, `@rules/topic-multi-tenancy.md`,
> `@rules/workflow-gated-actions.md`. Design: ADR-0010, threat-model **B8w**.

## When to use

- A customer used the portal Danger zone to **cancel** (offboard) or **schedule an erasure** of their
  own workspace, and you (operator) received the self-serve alert and want to confirm / triage it.
- The scheduled **erasure executor** (worker loop or the `erasure-sweep` CLI) **failed**, lagged, or
  you need to run/inspect it manually.
- A customer asks you to **cancel a pending erasure** for them (within the undo window), or asks why
  their workspace was offboarded.
- You are about to **flip the destructive feature flag on** in an environment (a gated change — see
  Prerequisites). For payment-method / plan-change / invoice issues, use the billing surfaces, not
  this runbook. For an **operator-initiated** purge use `rollback.md` / the `purge-expired` flow.

## Severity / impact

- **Cancel (offboard)** is **reversible**: the Neon project is retained (scaled to zero) and the
  connection secret kept until the retention window elapses; the tenant can be restored with
  `restore <id>`. A wrongful cancel is recoverable within the window → SEV3.
- **Erasure** is **irreversible once executed** (project deleted + connection secret crypto-shredded
  - signed certificate emitted). Before the undo window elapses it is fully cancellable. A wrongful
    _executed_ erasure is unrecoverable → treat a suspected wrong-account or griefing erasure as a
    **SEV2** and act **before** `execute-at`.
- A **silent non-execution** of the sweep is itself an incident: a scheduled GDPR erasure that never
  runs breaches the statutory SLA. Alert on the sweep not running, not just on it failing.

## Prerequisites & access

- **Feature flag:** the destructive pair is gated by `TENANTFORGE_PORTAL_SELFSERVE_DESTRUCTIVE`
  (`true`/`false`, **default `false`**). When OFF, the `/portal/api/cancel`, `/data-export`,
  `/erasure*`, and `/step-up` routes do not exist (404) and nothing is ever scheduled — the sweep
  no-ops. Cancel/erasure in this runbook apply only where the flag is ON.
- **Undo window:** `TENANTFORGE_PORTAL_ERASURE_UNDO_WINDOW_MS` (default **48h**). The window **plus**
  the executor's run cadence must stay **within the statutory erasure SLA** (GDPR Art. 17 "without
  undue delay") — see _GDPR SLA relationship_ below.
- **Alerts/email:** `TENANTFORGE_OPERATOR_EMAIL` + a configured `Notifier`
  (`TENANTFORGE_NOTIFIER=log|http|...`) so the operator + tenant alerts actually deliver. Without a
  notifier they degrade to audit-only (best-effort; never blocks the action).
- **Erasure store (multi-replica prerequisite — read before flipping the flag):** the
  pending-erasure store is **in-memory by default** (`createInMemoryPendingErasureStore`), which is
  per-instance. The undo-window safety (the single atomic `pending → processing` flip that prevents a
  cancel-vs-execute race and double-delete) is only correct cluster-wide if **all replicas share one
  store**. **A Postgres-backed pending-erasure store is therefore a hard prerequisite before
  enabling `…_DESTRUCTIVE=true` in a multi-replica deployment.** With the in-memory store, a sweep on
  replica B cannot see or atomically claim a record scheduled on replica A — the atomicity guarantee
  is lost. (Single-instance dev/staging is fine on the in-memory store.)
- **Erasure certificate signing key (hard prerequisite — erasure is always-signed):**
  `TENANTFORGE_ERASURE_SIGNING_KEY` is an **Ed25519 private key** (PKCS#8 PEM or private JWK; a
  secret from the secret manager — never committed/logged). **Production requires it** — the process
  **fails fast at startup** without it (`TENANTFORGE_ENV=production`), and scheduling a self-serve
  erasure **fails closed** without a signer, so a tenant can never be erased without a verifiable
  certificate. In non-prod with no key, an **ephemeral** key is generated at startup (logged warning;
  not verifiable across restarts) — fine for dev/staging, **not** production. Generate one:
  `openssl genpkey -algorithm ED25519`. **Verifying a certificate:** publish the public key with
  `tenantforge cli erasure-cert-pubkey > pub.jwk`, then an auditor/data subject runs
  `tenantforge cli erasure-cert-verify --jws cert.jws --pubkey pub.jwk` (offline; exits non-zero on
  any tamper/forgery/wrong-key/alg-confusion). A **post-erasure signing failure fails soft** (the
  data is already gone): the certificate is recorded **unsigned**, the `tenant.erased` event carries
  `signed:false`/`outcome:error`, and the operator is alerted — investigate the signing key, do not
  attempt to re-erase.
- CLI access to run `erasure-sweep` (it irreversibly deletes tenant DBs → `--yes` gated). Worker
  process access (logs) for the loop. Least-privilege Neon API key + registry credential from the
  secret manager (`secret-rotation.md`).

## The cancel path (reversible offboard)

A customer confirms cancel in the portal modal (step-up code required — see below). The server calls
`cancelTenant` → `offboard` (status `active → offboarding`). **It never calls `purge`.**

1. You receive the operator self-serve alert ("Self-serve cancel requested for tenant `<slug>`").
   Confirm it's expected (the customer, not an attacker/wrong account).
2. The response includes a **`reversibleUntil`** timestamp = `offboardedAt + retentionDays`. Tell the
   customer that deadline; until then the project is retained and a restore is possible.
3. A cancelled (`offboarding`) tenant is **excluded from billing/dunning sweeps** (they filter to
   `active` — red-team F3c), so the customer isn't charged/dunned after cancelling. Verify no
   stray charge fired (`GET /v1/billing/charges`).
4. **To reverse within the window:** `tenantforge cli restore <id>` (un-offboard; refused once past
   retention / purge-eligible — fail closed). See `rollback.md` for the lifecycle detail.

## The erasure path (typed-confirm + second-factor + mandatory undo window)

The portal gates the **request** with a typed `ERASE` confirmation **and** a control-plane
second-factor (a single-use, short-TTL emailed code — `/api/step-up`, **not** the IdP token). The
**execution** is gated by the mandatory undo window:

1. On confirm, the server calls `requestTenantErasure`, which **schedules** a pending record
   (`status='pending'`, `requestedAt`, `executeAt = requestedAt + undo-window`). **The tenant keeps
   serving during the window** — pending-erasure does _not_ suspend routing (avoids a timer-delayed
   self-serve DoS — red-team F2). Nothing is deleted yet.
2. Operator + the tenant's verified email are alerted on schedule (griefing tripwire / wrong-account
   safety net). The tenant's email is captured **at request time** (the record is gone by execution,
   so it can't be read then — review L2).
3. The customer can **cancel the pending erasure until `execute-at`** (portal `Cancel scheduled
erasure`, or operator `cancelTenantErasure` — see below). Cancel is the same single atomic flip
   (`pending → cancelled`); it wins only if the executor hasn't already claimed the row.
4. **After `execute-at`,** the executor sweep claims and runs it (next section). Only the winner of
   the atomic flip runs the verified-erasure engine (export → delete project → crypto-shred key →
   signed certificate); operator + the (request-time-captured) tenant email are alerted on execution.

> **What gates what:** typed-confirm + second-factor gate the _request_; the **undo window** gates
> the _execution_. A stale session alone can never trigger destruction.

## The executor sweep (worker loop + CLI)

The sweep is the scheduled executor that runs due erasures. It is **always run** (not flag-gated) —
but with the flag OFF nothing is ever scheduled, so it no-ops; without it, a scheduled erasure would
never execute and the SLA is unmeetable.

- **Worker loop (default):** `runWorkerCycle` drains the lifecycle queue, then calls `erasureSweep()`
  every poll cycle (`pnpm worker`). A sweep error is caught + logged — it can **never crash the
  worker**.
- **CLI (manual / cron):** `tenantforge cli erasure-sweep --yes` (`--limit N`, default 100). It is
  `--yes` gated because each processed record irreversibly deletes a tenant DB. Prints
  `erasure sweep: P erased, S skipped, F failed of N due erasure(s)` and exits non-zero if any failed.

### Reading the sweep report

`erasureSweep` returns `{ scanned, processed[], skipped[], failed[] }`, and emits a
`tenant.erasure_sweep` audit event (`outcome: error` iff `failed > 0`):

- **`scanned`** — records past `execute-at` this run (bounded by `--limit`).
- **`processed`** — erased successfully (a signed certificate was produced).
- **`skipped`** — the atomic flip was **lost**: the record was already cancelled, already
  processing/done, or claimed by a concurrent sweep / at-least-once redelivery. This is **expected
  and safe** — a skip means _no_ re-export/re-delete happened (idempotent). It is **not** a failure.
- **`failed`** — the erasure engine threw for that tenant (e.g. Neon API error). **Failure-isolated:**
  one tenant's failure never blocks the rest of the sweep.

### If the sweep fails (a tenant in `failed[]`)

1. The sweep is **idempotent and resumable** — **re-run** `erasure-sweep --yes`. The atomic claim
   means a record that already completed is skipped, not re-deleted; only genuinely-unfinished
   records are retried.
2. If the same tenant keeps failing, **investigate that tenant individually**: read the
   `tenant.erased` event (`outcome: error`) and the engine error in the failed-row message; check the
   Neon API (project still present? API key valid? rate-limited?) and the secret store. Fix the root
   cause (often an upstream Neon `429`/outage — see `scaling.md` / `incident-response.md`), then
   re-run.
3. A persistently-failing erasure that approaches the statutory SLA is an **incident** — escalate
   (`incident-response.md`); the customer's erasure right is time-bound.

### To cancel a pending erasure for a tenant (operator)

Within the undo window: `cancelTenantErasure(tenantId)` (library/facade) performs the atomic
`pending → cancelled` flip and emits `tenant.erasure_cancelled` (`outcome: ok` iff a pending record
was cancelled). It **fails to cancel** (returns false / `outcome: error`) if the executor already
claimed the row — at that point the erasure is in-flight/done and cannot be stopped. Confirm via the
audit trail before telling the customer it's cancelled.

## GDPR Art. 17 SLA relationship

The undo window is a deliberate, documented delay before an irreversible deletion — it must **not**
push total time past the statutory "without undue delay" expectation. Budget:

```
total erasure time  =  undo window  +  executor latency (worst-case run cadence)  +  engine runtime
                    ≤  the statutory erasure SLA you commit to
```

So: keep `…_ERASURE_UNDO_WINDOW_MS` (default 48h) plus the worker poll interval / cron cadence
comfortably **inside** your committed SLA. If you lengthen the undo window, shorten the SLA margin
elsewhere or shorten the executor cadence. Document the committed SLA where you publish your DSAR
policy.

## The destructive feature flag (gated decision)

- `TENANTFORGE_PORTAL_SELFSERVE_DESTRUCTIVE` ships **`false`** (ADR-0010 / red-team F6). The
  payment-method / plan-change / invoice surfaces are **unaffected** by this flag and are always
  available when the portal is mounted.
- **Flipping it on is a gated change** (`@rules/workflow-gated-actions.md`) — never self-approved.
  Pre-flight, confirm **all** hold: (a) the destructive abuse tests are green
  (`test/app/portal-selfserve*.test.ts`, `test/adapters/{one-time-code,pending-erasure}-store.test.ts`);
  (b) a security review of B8w is signed off; (c) for **multi-replica prod**, a **Postgres-backed
  pending-erasure store is wired** (the in-memory default is per-instance — see Prerequisites); (d) a
  notifier + `TENANTFORGE_OPERATOR_EMAIL` are configured so the self-serve alerts deliver; (e) the
  undo window + executor cadence fit the SLA (above). Deploy is decoupled from release: ship the code
  with the flag OFF, flip the flag as a separate, audited, approved config change
  (`@rules/topic-config-environments.md`).

## Verification

- After a cancel: the tenant is `offboarding`, a `tenant.offboarded` event (`context.selfServe:
true`, `reversibleUntil`) is in the audit trail, and no post-cancel charge fired.
- After scheduling an erasure: a `tenant.erasure_requested` event (`context.executeAt`) exists; the
  tenant **still routes** (keeps serving) during the window.
- After a sweep: exit code `0` (CLI) / no error line (worker); a `tenant.erasure_sweep` event whose
  counts reconcile (`scanned = processed + skipped + failed` for the bounded batch); each processed
  tenant has a `tenant.erased` event (`context.verified: true`) and the customer received the
  certificate alert.

## Alerts & audit events to check

| Signal                                                      | Where                                                      |
| ----------------------------------------------------------- | ---------------------------------------------------------- |
| Self-serve cancel/erasure requested                         | Operator email + the tenant's verified email (best-effort) |
| `tenant.offboarded` (`selfServe: true`, `reversibleUntil`)  | audit trail (cancel)                                       |
| `tenant.erasure_requested` (`executeAt`)                    | audit trail (erasure scheduled)                            |
| `tenant.erasure_cancelled` (`outcome: ok`/`error`)          | audit trail (undo)                                         |
| `tenant.erased` (`verified`)                                | audit trail (executed) — `outcome: error` ⇒ investigate    |
| `tenant.erasure_sweep` (`scanned/processed/skipped/failed`) | audit trail (per sweep run)                                |
| `tenant.exported` (`location`, size)                        | audit trail (data-export / DSAR)                           |

(All events are redacted — never a card PAN, connection URI, or recipient address.)

## Rollback / abort

- **Pending erasure (not yet executed):** cancel it (above) — fully reversible until `execute-at`.
- **Cancelled (offboarded) tenant:** `restore <id>` within the retention window.
- **Executed erasure:** **not reversible** — the project is deleted and the key shredded. If a wrong
  account was erased, this is a SEV1/2 incident: preserve evidence, follow `incident-response.md`,
  and recover from backup only if the Neon project's PITR window still covers it (`backup-restore.md`)
  — assume it does not.
- **Mass / runaway sweep concern:** there is no "undo"; the per-run `--limit` bounds blast radius.
  Stop the worker / hold the cron, investigate, then resume.

## Escalation

- Alert **the maintainer** (ntfy) for: a persistently-failing sweep nearing the SLA, a suspected wrong-account or
  griefing erasure (act before `execute-at`), or any cross-tenant anomaly. A suspected wrong erasure
  or mass-erasure is a security incident → `incident-response.md`. As the **maintainer** (and
  data-protection owner), honor breach-notification duties for any executed erasure that may have been
  in error (`@rules/std-privacy.md`).

## Related

- `incident-response.md` (wrong-account / mass erasure = SEV1/2), `rollback.md` + `restore`
  (un-offboard), `backup-restore.md` (Neon PITR), `secret-rotation.md`, `scaling.md` (Neon API
  limits); ADR-0010, threat-model B8w; rules `@rules/std-privacy.md`,
  `@rules/workflow-gated-actions.md`, `@rules/topic-multi-tenancy.md`.

---

_Last validated: 2026-06-24 (authored with Phase 3; drill at the next game-day — the destructive flag
is OFF, so the live path is exercised by the abuse-test suite + a single-instance staging run before
any flag flip). Owner: TenantForge maintainers._
