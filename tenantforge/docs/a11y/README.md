# TenantForge — Manual Accessibility Pass (gap B1)

TenantForge targets **WCAG 2.2 AA** as the floor for every user-facing console (master §1;
`@rules/topic-accessibility.md`). Automated **axe-core** checks run in CI over every screen of all
three SPAs (`shared/test/shell.test.tsx`, `{dashboard,portal,signup}/test/App.test.tsx`) — but
automation catches only **~30–40%** of real issues. The remaining ~60% (keyboard operability, focus
management, screen-reader name/role/state, meaningful announcements, contrast/reflow) needs a
**human keyboard-only pass + a screen-reader pass**. This directory is that pass — gap **B1**.

## Status: OUTSTANDING (human-executed)

An agent authored these checklists but **cannot drive a real screen reader**, so the passes are **not
yet executed**. B1 is "done" only when a human runs all three plans on the platforms below, records
results in each plan's log, and files/fixes any issues. Do **not** treat these documents as evidence
the passes were performed.

## The three plans

| Console            | SPA          | Plan                                                               | Notes                                                                                                     |
| ------------------ | ------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Operator dashboard | `dashboard/` | [`dashboard-manual-test-plan.md`](./dashboard-manual-test-plan.md) | Shared app shell + read panels + evidence detail + **reconcile-execute** (RBAC/CSRF)                      |
| Customer portal    | `portal/`    | [`portal-manual-test-plan.md`](./portal-manual-test-plan.md)       | Shared app shell + billing/plan/payment + flag-gated **Danger zone** (modals — the focus-management crux) |
| Self-serve signup  | `signup/`    | [`signup-manual-test-plan.md`](./signup-manual-test-plan.md)       | Public multi-step wizard (no shell): captcha, verify code, Stripe, provisioning poll                      |

> **Shared app shell:** the dashboard and portal use the same `shared/ui` `AppShell` (skip link, top
> bar, left nav/drawer, theme toggle). Its keyboard + SR behavior (skip link, landmark structure,
> focus-to-`<h1>` on nav, `aria-current`, the responsive drawer trap) is the same in both — run it in
> full once, then re-verify only the app-specific nav in the other. Signup does **not** use the shell.

## Environment (once, for all three)

- **Build/serve** the staging build of each SPA (`pnpm {dashboard,portal,signup}:build` → serve
  `dist`, or `:dev`), reachable **tailnet-only** over HTTPS (`@rules/topic-tailnet-dev-access.md`;
  the dashboard/portal session cookies are `Secure`).
- **Flags/data:** portal Danger zone needs `TENANTFORGE_PORTAL_SELFSERVE_DESTRUCTIVE=true`; signup
  needs a signup secret + **Stripe test mode** + a **test Turnstile** key so captcha/payment are
  reachable. For the dashboard, test with **both** a `tenant:provision` operator and a **read-only**
  one.
- **Test matrix (per plan):** keyboard-only; **NVDA** (Windows, nvaccess.org) + Chrome/Edge;
  **VoiceOver** (macOS, ⌘F5) + Safari. Also: **400% zoom / ~320px** reflow, **both light + dark**
  themes, and OS **reduced-motion** on.

## Procedure

1. Pick a console + platform. Work top-to-bottom through that plan's **Part A (keyboard-only)** with
   the mouse unplugged, then **Part B (screen-reader)** with the SR on.
2. For every step, compare against the "Expected" column; a mismatch is a **finding** — file a GitHub
   issue labelled `a11y`, reference the plan step id (e.g. `dashboard A6.2`) and the WCAG criterion,
   and link it in that plan's results log.
3. Fix findings, then re-run the affected steps. Repeat until each plan's log is all-pass.
4. Record tester / date / browser+SR / pass-fail in each plan's **Results log**, and roll the outcome
   up into the sign-off below.

## Consolidated sign-off (definition of done)

B1 is complete when **every cell** is a recorded pass (or a filed+fixed issue), across all three
consoles and both screen readers:

| Console   | Keyboard-only | NVDA (Win) | VoiceOver (mac) |
| --------- | ------------- | ---------- | --------------- |
| Dashboard | ☐             | ☐          | ☐               |
| Portal    | ☐             | ☐          | ☐               |
| Signup    | ☐             | ☐          | ☐               |

**Re-run triggers:** re-run the relevant plan after any change to the shared shell / routing / focus
management, the portal Danger-zone modals, the dashboard reconcile-execute or evidence-detail region,
or the signup funnel steps — and, for the portal, **before flipping the destructive flag on in
production**.

## References

- **WCAG 2.2** — w3.org/TR/WCAG22; **WAI-ARIA APG** — w3.org/WAI/ARIA/apg (dialog, listbox patterns).
- **WebAIM** screen-reader testing — webaim.org; **The A11Y Project** — a11yproject.com.
- `@rules/topic-accessibility.md`; the automated pass — `shared/test/shell.test.tsx` +
  `{dashboard,portal,signup}/test/App.test.tsx` (axe-core).
