# Self-Serve Signup — Manual Accessibility Test Plan (WCAG 2.2 AA)

> The **manual** half of the public signup SPA's a11y verification. Automated **axe-core** assertions
> run in CI on every step (`tenantforge/signup/test/App.test.tsx`), but automation catches only
> ~30–40% of issues (`@rules/topic-accessibility.md`). This is the **keyboard-only** and
> **screen-reader** walkthrough a human runs to cover the rest, each step mapped to a WCAG 2.2 AA
> success criterion.
>
> **Status — OUTSTANDING HUMAN TASK.** The keyboard pass and the NVDA + VoiceOver passes **have not
> been executed** by an agent. A human runs them and records results at the bottom. See
> [`README.md`](./README.md) for the overall B1 pass, environment, and sign-off.

## Scope

The signup SPA (`tenantforge/signup/`) — the **public, unauthenticated** onboarding wizard. Unlike
the dashboard/portal it does **not** use the operator app-shell; it is a single-`<h1>` multi-step
funnel: **Start** (email + Turnstile captcha) → **Verify** (emailed 6-digit code) → **Details**
(slug, region, plan) → **Payment** (Stripe Elements SetupIntent) → **Provisioning** (status poll) →
**Done** (connection info). Because it is the abuse-prone front door (threat-model B12), a11y here is
about the **step-to-step flow, live-region announcements, captcha reachability, the Stripe iframe,
and the poll status** — not shell navigation.

## Tooling & setup

- **Browsers/SRs:** Chrome/Edge + **NVDA**; Safari + **VoiceOver**. Run each with at least one of each.
- **Build:** `pnpm signup:build` then serve `signup/dist` (or `pnpm signup:dev`). Needs a signup
  secret configured so the flow is enabled; use **Stripe test mode** + a **test Turnstile** site key so
  the captcha and payment steps are reachable end-to-end.
- **Zoom/reflow:** 400% zoom / ~320px narrow viewport. **Both light and dark themes.**

## How to run each pass

- **Keyboard-only:** ignore the mouse. Drive the whole funnel with `Tab`/`Shift+Tab`/`Enter`/`Space`.
  A multi-step form's crux is **focus management on each step transition** — note wherever focus is
  lost to `<body>` or left on a now-hidden control.
- **Screen-reader:** verify each step's heading is announced on advance, each field announces
  name/role/state, errors are announced, and the async statuses (sending code, provisioning) are
  announced — not silent.

---

## Part A — Keyboard-only walkthrough

### A1. Start — email + captcha

| #    | Step                                        | Expected                                                                                                                                            | WCAG 2.2 AA                                |
| ---- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| A1.1 | Load the page                               | Focus/first stop reaches the `<h1>` then the email field; the page has a `lang` and a sensible title                                                | 2.4.3 Focus Order; 3.1.1                   |
| A1.2 | `Tab` to the email field                    | Visible, programmatic label; `type="email"` + `autocomplete="email"`                                                                                | 1.3.1; 1.3.5 Identify Input Purpose; 3.3.2 |
| A1.3 | Reach the **Turnstile captcha**             | The captcha widget is keyboard-reachable and completable without a mouse; if it fails to load, the failure is surfaced (not a silent dead Continue) | 2.1.1 Keyboard; 4.1.2; 3.3.1               |
| A1.4 | Continue with an invalid email / no captcha | Guarded; the error is in a `role="alert"`; Continue stays disabled until preconditions are met (not a silent no-op)                                 | 3.3.1; 4.1.2                               |
| A1.5 | Submit valid                                | Advance to Verify; **focus moves to the new step's heading/first field** (not lost); a "code sent" status is announced                              | 2.4.3; 4.1.3 Status Messages               |

### A2. Verify — emailed code

| #    | Step                    | Expected                                                                          | WCAG 2.2 AA         |
| ---- | ----------------------- | --------------------------------------------------------------------------------- | ------------------- |
| A2.1 | `Tab` to the code field | Labelled; `autocomplete="one-time-code"` + `inputmode="numeric"`                  | 1.3.1; 1.3.5; 3.3.2 |
| A2.2 | Enter a wrong code      | Error in `role="alert"`; attempts-remaining/lock conveyed as text; focus not lost | 3.3.1; 4.1.3        |
| A2.3 | Resend code             | Reachable; the "code re-sent" confirmation is announced (`role="status"`)         | 2.1.1; 4.1.3        |
| A2.4 | Enter the correct code  | Advance to Details; focus moves to the new step                                   | 2.4.3               |

### A3. Details — slug / region / plan

| #    | Step                                | Expected                                                                                                                      | WCAG 2.2 AA                   |
| ---- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| A3.1 | `Tab` through slug, region, plan    | Each has a visible + programmatic label; region/plan selects are native or ARIA-correct listboxes                             | 1.3.1; 3.3.2; 4.1.2           |
| A3.2 | Enter an invalid/taken slug, submit | The error is announced + associated with the field (`aria-describedby`); a generic "slug unavailable" (no enumeration oracle) | 3.3.1; 3.3.3 Error Suggestion |
| A3.3 | Submit valid                        | Advance to Payment; focus moves to the new step                                                                               | 2.4.3                         |

### A4. Payment — Stripe Elements

| #    | Step                                    | Expected                                                                                       | WCAG 2.2 AA            |
| ---- | --------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------- |
| A4.1 | Reach the card field                    | "Card details" label associated; the Stripe iframe is keyboard-reachable                       | 1.3.1; 2.1.1           |
| A4.2 | `Tab` into and out of the Stripe iframe | No keyboard trap entering/leaving the embedded field                                           | 2.1.2 No Keyboard Trap |
| A4.3 | Submit before Elements is ready         | Save/Continue is disabled (not a silent dead button); any gateway error is in a `role="alert"` | 4.1.2; 3.3.1           |
| A4.4 | Submit a valid test card                | Advance to Provisioning; focus moves; a "setting up" status is announced                       | 2.4.3; 4.1.3           |

### A5. Provisioning (poll) → Done

| #    | Step                     | Expected                                                                                        | WCAG 2.2 AA         |
| ---- | ------------------------ | ----------------------------------------------------------------------------------------------- | ------------------- |
| A5.1 | While provisioning polls | Progress is conveyed via `role="status"` (announced), not a spinner alone; no motion discomfort | 4.1.3; 1.4.1; 2.3.3 |
| A5.2 | On failure               | The failure is announced (`role="alert"`) with a next step; focus not lost                      | 3.3.1; 4.1.3        |
| A5.3 | On success (Done)        | The connection info / next step is reachable, shown as **text** (copyable), and announced       | 4.1.3; 1.3.1        |

---

## Part B — Screen-reader checklist (NVDA + VoiceOver)

Mark NVDA and VO independently. Verify each control speaks **name**, **role**, **state**.

### B1. Structure & flow

- [ ] Page has a `lang` and a meaningful `<title>`; the current step is a single `<h1>`, announced on each advance. — _3.1.1, 1.3.1, 2.4.3_
- [ ] Step transitions **move focus** to the new step and the SR announces it (no silent step change). — _2.4.3, 4.1.3_
- [ ] Progress through steps is perceivable (e.g. "Step 2 of 5" announced), not visual-only. — _1.3.1_

### B2. Fields & captcha

- [ ] Email/code/slug/region/plan fields announce label + purpose (`autocomplete`) + required state. — _1.3.1, 1.3.5, 3.3.2_
- [ ] The **Turnstile captcha** is operable + its state (solved / needs input / failed) is perceivable to the SR; a load failure is announced. — _2.1.1, 4.1.2, 4.1.3_
- [ ] Every validation error is **announced** when it appears (`role="alert"`) and tied to its field. — _3.3.1, 4.1.3_
- [ ] "Continue"/submit announces **disabled** until its step's preconditions are met. — _4.1.2_

### B3. Payment

- [ ] "Card details" label is associated with the Stripe Element; no trap. — _1.3.1, 2.1.2_
- [ ] Save/Continue announces **disabled** until Elements is ready; success/failure announced (`role="status"`/`role="alert"`). — _4.1.2, 4.1.3_

### B4. Provisioning → Done

- [ ] The provisioning poll status is **announced** as it changes; a failure is announced with a next step. — _4.1.3, 3.3.1_
- [ ] The final connection info is announced and conveyed in **text** (not color/icon only). — _4.1.3, 1.4.1_

### B5. Preferences

- [ ] OS **reduced-motion** honored (poll spinner/transitions). — _2.3.3_
- [ ] **Dark/light** follow `prefers-color-scheme`; contrast holds in both (incl. the #FE6601 accent). — _1.4.3_

---

## Results log (fill in when executed)

| Pass              | Tester | Date  | Browser / SR  | Result        | Issues filed |
| ----------------- | ------ | ----- | ------------- | ------------- | ------------ |
| Keyboard-only     | _TBD_  | _TBD_ | _TBD_         | ☐ pass ☐ fail | _link_       |
| NVDA (Windows)    | _TBD_  | _TBD_ | Chrome + NVDA | ☐ pass ☐ fail | _link_       |
| VoiceOver (macOS) | _TBD_  | _TBD_ | Safari + VO   | ☐ pass ☐ fail | _link_       |

> Re-run after any change to the funnel steps, focus management on step transitions, the captcha
> integration, the Stripe step, or the provisioning-poll status.

## References

- WCAG 2.2 — w3.org/TR/WCAG22; WAI-ARIA APG — w3.org/WAI/ARIA/apg. `@rules/topic-accessibility.md`.
