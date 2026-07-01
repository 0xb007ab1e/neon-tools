# Operator Dashboard — Manual Accessibility Test Plan (WCAG 2.2 AA)

> The **manual** half of the operator dashboard's a11y verification. Automated **axe-core** assertions
> run in CI over every screen (`tenantforge/dashboard/test/App.test.tsx`, plus the shared shell in
> `shared/test/shell.test.tsx`), but automation catches only ~30–40% of issues
> (`@rules/topic-accessibility.md`). This is the **keyboard-only** and **screen-reader** walkthrough a
> human runs to cover the rest, each step mapped to a WCAG 2.2 AA success criterion.
>
> **Status — OUTSTANDING HUMAN TASK.** This is the _checklist_; the keyboard pass and the NVDA +
> VoiceOver passes **have not been executed** by an agent (an agent cannot drive a real screen
> reader). A human runs them and records results in the log at the bottom. See
> [`README.md`](./README.md) for the overall B1 pass, environment, and sign-off.

## Scope

The dashboard SPA (`tenantforge/dashboard/`): operator sign-in (token → session cookie), the
**shared app shell** (skip link, top bar, left nav/drawer, theme toggle — the same `shared/ui`
`AppShell` the portal uses), the read panels (Compliance report, Evidence bundles list + detail,
Evidence public key, Operator digest, Webhook subscriptions, Fleet drift, Cost + cost anomalies,
Invoices), and the one **mutating** flow — **execute fleet reconcile** (RBAC-gated + CSRF). Run a
staging build with an operator token that has `tenant:provision` (so reconcile-execute is reachable)
and, separately, a **read-only** operator (to verify the mutation is correctly gated, not just
hidden).

## Tooling & setup

- **Browsers/SRs:** Chrome/Edge + **NVDA** (Windows, nvaccess.org); Safari + **VoiceOver** (macOS,
  ⌘F5). Run each flow with at least one of each.
- **Build:** `pnpm dashboard:build` then serve `dashboard/dist` (or `pnpm dashboard:dev`), reachable
  tailnet-only in dev (`@rules/topic-tailnet-dev-access.md`) over HTTPS (the session cookie is
  `Secure`).
- **Zoom/reflow:** 400% zoom / ~320px CSS-px narrow viewport (the nav collapses to the hamburger
  drawer — test the drawer with the keyboard). **Both light and dark themes.**

## How to run each pass

- **Keyboard-only:** ignore the mouse. `Tab`/`Shift+Tab`/`Enter`/`Space`/`Esc`/arrows. Note anything
  you can't reach, can't activate, can't see focus on, or that traps you.
- **Screen-reader:** navigate by `Tab`, headings (NVDA `H` / VO `VO+Cmd+H`), landmarks (NVDA `D` / VO
  rotor), and form fields. Every control must announce **name**, **role**, and **state**, and dynamic
  changes must be announced.

---

## Part A — Keyboard-only walkthrough

### A1. Shared app shell (every screen)

> Same shell as the portal — if you already ran the portal keyboard pass, re-verify only the
> dashboard-specific nav items here.

| #    | Step                                           | Expected                                                                                                                              | WCAG 2.2 AA                                    |
| ---- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| A1.1 | Load, press `Tab` once                         | First stop is the **"Skip to content"** link, visible on focus                                                                        | 2.4.1 Bypass Blocks; 2.4.11 Focus Not Obscured |
| A1.2 | Activate skip link                             | Focus jumps to the section `<h1>` (main content)                                                                                      | 2.4.1; 2.4.3 Focus Order                       |
| A1.3 | `Tab` the top bar; activate the theme toggle   | Theme toggle + Sign out reachable, sensible order, visible focus ring; toggle label updates, focus stays                              | 2.1.1 Keyboard; 2.4.7 Focus Visible; 1.4.3     |
| A1.4 | `Tab` into the nav; activate each section link | Section changes; focus moves to the new `<h1>`; `aria-current="page"` tracks the active link                                          | 2.4.3; 3.2.3 Consistent Navigation             |
| A1.5 | Narrow viewport: open the hamburger **drawer** | The drawer opens from the keyboard, focus moves into it, `Tab` stays within while open, `Esc` closes + returns focus to the hamburger | 2.1.1; 2.1.2 No Keyboard Trap; 2.4.3           |
| A1.6 | At 400% zoom, repeat A1.1–A1.5                 | No loss of content/function; no horizontal scroll for text; focus still visible                                                       | 1.4.10 Reflow; 1.4.4 Resize Text               |

### A2. Sign in (token → session)

| #    | Step               | Expected                                                                                     | WCAG 2.2 AA                              |
| ---- | ------------------ | -------------------------------------------------------------------------------------------- | ---------------------------------------- |
| A2.1 | Load signed-out    | Focus lands on the "Sign in" `<h1>`; the token field + Sign in button are keyboard-reachable | 2.4.3; 2.1.1                             |
| A2.2 | Token field        | Has a visible, programmatic label; is a secure/password field                                | 1.3.1 Info & Relationships; 3.3.2 Labels |
| A2.3 | Submit a bad token | Error appears in a `role="alert"`; focus is not lost                                         | 3.3.1 Error Identification; 4.1.3 Status |

### A3. Read panels (Compliance / Evidence / Digest / Drift / Cost / Invoices)

| #    | Step                              | Expected                                                                                                                                          | WCAG 2.2 AA                      |
| ---- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| A3.1 | Visit each panel; `Tab` through   | Focusable elements in reading order; nothing skipped/off-screen; each panel has one `<h1>`/section heading                                        | 2.4.3; 1.3.2 Meaningful Sequence |
| A3.2 | Any data table                    | Visible caption; real `<th scope="col">` headers                                                                                                  | 1.3.1                            |
| A3.3 | While a panel is "Loading…"       | Conveyed via `role="status"`, not a spinner alone                                                                                                 | 4.1.3; 1.4.1 Use of Color        |
| A3.4 | Evidence bundles: select a bundle | The detail opens in the labelled region (`role="region"` "Selected evidence bundle"); focus moves to it; a fetch error surfaces in `role="alert"` | 1.3.1; 2.4.3; 3.3.1              |
| A3.5 | Evidence public key               | The key/verification text is selectable, reachable, and shown as text (an auditor copies it)                                                      | 1.3.1                            |

### A4. Execute fleet reconcile (mutating, RBAC + CSRF)

| #    | Step                                       | Expected                                                                                                      | WCAG 2.2 AA             |
| ---- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ----------------------- |
| A4.1 | As an operator **with** `tenant:provision` | The reconcile plan + the Execute control are keyboard-reachable; Execute has a clear label                    | 2.1.1; 1.3.1            |
| A4.2 | Trigger Execute                            | The outcome (reconciled/partial) is announced via `role="status"`; focus is not lost                          | 4.1.3; 2.4.3            |
| A4.3 | As a **read-only** operator                | Execute is either absent or clearly disabled with an accessible name conveying why (not a silent dead button) | 4.1.2 Name, Role, Value |

---

## Part B — Screen-reader checklist (NVDA + VoiceOver)

For every control verify a meaningful **name**, correct **role**, and any **state**. Mark NVDA and VO
independently.

### B1. Structure & navigation (every screen)

- [ ] **Landmarks** present + labelled: `banner`, `navigation`, `main`; navigable by landmark/rotor. — _1.3.1, 2.4.1_
- [ ] **One `<h1>` per screen** (= section name); logical heading outline, navigable by heading. — _1.3.1, 2.4.6_
- [ ] On section change, the SR **announces the new heading** (focus moved to `<h1>`). — _2.4.3, 4.1.3_
- [ ] Skip link announced + works; active nav item announces **current** (`aria-current="page"`). — _2.4.1, 4.1.2_
- [ ] The collapsed **hamburger drawer** announces expanded/collapsed state + is operable. — _4.1.2_
- [ ] Page `lang` is `en`. — _3.1.1 Language of Page_

### B2. Sign in

- [ ] Token field announces label + that it's a secure field; Sign in button announces name + role. — _1.3.1, 4.1.2_
- [ ] A login error is **announced** (`role="alert"`). — _4.1.3, 3.3.1_

### B3. Read panels

- [ ] Each **table** announces caption + column headers when navigating cells. — _1.3.1_
- [ ] Key/value lists (report inventory, digest counts) read as label → value. — _1.3.1_
- [ ] "Loading…"/empty states announced (`role="status"`). — _4.1.3_
- [ ] Money/usage/counts intelligible read aloud (e.g. "$5.00"), not symbol-only. — _1.3.1_
- [ ] Selecting an evidence bundle **announces** the detail region + moves focus to it; a fetch error is announced. — _2.4.3, 4.1.3_
- [ ] Isolation/residency **compliant/violation** status is conveyed in text, not color/icon only. — _1.4.1 Use of Color_

### B4. Execute fleet reconcile

- [ ] The Execute control announces name + role; for a read-only operator it announces **disabled** (or is absent). — _4.1.2_
- [ ] The reconcile outcome (reconciled/partial counts) is **announced** as a status. — _4.1.3_

### B5. Preferences

- [ ] With OS **reduced-motion** on, no spinner/transition causes discomfort (`prefers-reduced-motion` honored). — _2.3.3_
- [ ] **Dark/light** follow `prefers-color-scheme`; the toggle persists; contrast holds in both (incl. the #FE6601 accent — white-on-base fails, `--accent-fill` is used). — _1.4.3_

---

## Results log (fill in when executed)

| Pass              | Tester | Date  | Browser / SR  | Result        | Issues filed |
| ----------------- | ------ | ----- | ------------- | ------------- | ------------ |
| Keyboard-only     | _TBD_  | _TBD_ | _TBD_         | ☐ pass ☐ fail | _link_       |
| NVDA (Windows)    | _TBD_  | _TBD_ | Chrome + NVDA | ☐ pass ☐ fail | _link_       |
| VoiceOver (macOS) | _TBD_  | _TBD_ | Safari + VO   | ☐ pass ☐ fail | _link_       |

> Re-run after any change to the shell, routing/focus management, the evidence-detail region, or the
> reconcile-execute flow.

## References

- WCAG 2.2 — w3.org/TR/WCAG22; WAI-ARIA APG — w3.org/WAI/ARIA/apg. `@rules/topic-accessibility.md`.
