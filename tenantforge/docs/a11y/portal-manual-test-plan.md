# Customer Portal — Manual Accessibility Test Plan (WCAG 2.2 AA)

> The **manual** half of the portal's a11y verification. Automated **axe-core** assertions run in CI
> over every screen and every modal (`tenantforge/portal/test/App.test.tsx`), but automation catches
> only ~30–40% of issues (`@rules/topic-accessibility.md`). This plan is the **keyboard-only** and
> **screen-reader** walkthrough a human runs to cover the rest, each step mapped to a WCAG 2.2 AA
> success criterion.
>
> **Status — OUTSTANDING HUMAN TASK.** This is the _checklist_, authored alongside Phase 3. The
> keyboard pass and the NVDA + VoiceOver passes **have not been executed** by the agent (an agent
> cannot drive a real screen reader). A human must run them and record results in the table at the
> bottom before the portal's a11y is "done." Do not treat this document as evidence the SR pass was
> performed.

## Scope

The portal SPA (`tenantforge/portal/`): Sign in (OIDC + dev-token), Overview, Billing, Plan, Payment
method, and the flag-gated Danger zone (data export, cancel, erasure + undo-window status). Run with
the destructive feature flag **ON** in a staging build so the Danger zone is reachable
(`TENANTFORGE_PORTAL_SELFSERVE_DESTRUCTIVE=true`).

## Tooling & setup

- **Browsers:** latest Chrome/Edge (+ NVDA) on Windows; Safari (+ VoiceOver) on macOS.
- **Screen readers:** **NVDA** (Windows, free — nvaccess.org) and **VoiceOver** (macOS, built in —
  ⌘F5). Test each flow with at least one of each platform.
- **Build:** `pnpm portal:build` then serve `portal/dist` (or `pnpm portal:dev`), reachable tailnet-only
  in dev (`@rules/topic-tailnet-dev-access.md`).
- **Zoom/reflow:** browser at 400% zoom / 1280px CSS-px-equivalent narrow viewport.
- Test in **both** light and dark themes (the in-app toggle) — contrast must hold in both.

## How to run each pass

- **Keyboard-only:** unplug/ignore the mouse. Drive everything with `Tab` / `Shift+Tab` / `Enter` /
  `Space` / `Esc` / arrow keys. Note any element you can't reach, can't activate, can't see the focus
  on, or that traps you.
- **Screen-reader:** with the SR on, navigate by `Tab`, by headings (NVDA `H` / VO `VO+Cmd+H`), by
  landmarks (NVDA `D` / VO rotor), and by form fields. Verify every control announces a **name**,
  **role**, and **state**, and that dynamic changes are announced.

---

## Part A — Keyboard-only walkthrough

### A1. Global / shell (every screen)

| #    | Step                                           | Expected                                                                                                   | WCAG 2.2 AA                                        |
| ---- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| A1.1 | Load the app, press `Tab` once                 | The first stop is the **"Skip to content"** link, which becomes visible on focus                           | 2.4.1 Bypass Blocks; 2.4.11 Focus Not Obscured     |
| A1.2 | Activate the skip link (`Enter`)               | Focus jumps to the `#section-heading` `<h1>` (main content)                                                | 2.4.1; 2.4.3 Focus Order                           |
| A1.3 | `Tab` through the top bar                      | Theme toggle and Sign out are reachable, in a sensible order, each with a visible focus ring               | 2.1.1 Keyboard; 2.4.7 Focus Visible; 2.4.3         |
| A1.4 | Activate the theme toggle                      | Theme switches; focus stays on the toggle; its label updates ("Switch to light/dark theme")                | 2.1.1; 1.4.3 Contrast (re-verify in the new theme) |
| A1.5 | `Tab` into the nav, activate each section link | The section changes; focus moves to the new section's `<h1>`; `aria-current="page"` tracks the active link | 2.4.3; 2.4.7; 3.2.3 Consistent Navigation          |
| A1.6 | Verify nothing is mouse-only                   | Every action (links, buttons, toggles) is operable from the keyboard; no keyboard trap anywhere            | 2.1.1; 2.1.2 No Keyboard Trap                      |
| A1.7 | At 400% zoom, repeat A1.1–A1.6                 | No loss of content/function; no horizontal scroll for text; focus still visible                            | 1.4.10 Reflow; 1.4.4 Resize Text                   |

### A2. Sign in

| #    | Step                                       | Expected                                                                                                    | WCAG 2.2 AA                                              |
| ---- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| A2.1 | Load signed-out (OIDC mode)                | Focus lands on the "Sign in" `<h1>`; the "Sign in with your identity provider" button is keyboard-reachable | 2.4.3; 2.1.1                                             |
| A2.2 | Token mode (dev): `Tab` to the token field | The field has a visible, programmatic label ("Portal token"); `Tab` reaches the Sign in button              | 1.3.1 Info & Relationships; 3.3.2 Labels or Instructions |
| A2.3 | Submit a bad token                         | An error appears in a `role="alert"`; focus handling does not lose the user                                 | 3.3.1 Error Identification; 4.1.3 Status Messages        |

### A3. Overview / Billing (read screens)

| #    | Step                                | Expected                                                                                    | WCAG 2.2 AA                      |
| ---- | ----------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------- |
| A3.1 | Navigate to Overview, `Tab` through | Tables/labels are reachable in reading order; no focusable element is skipped or off-screen | 2.4.3; 1.3.2 Meaningful Sequence |
| A3.2 | Navigate to Billing                 | Each table has a visible caption; column headers are real `<th scope="col">`                | 1.3.1                            |
| A3.3 | While a panel is "Loading…"         | The loading status is conveyed (a `role="status"`), not by a spinner alone                  | 4.1.3; 1.4.1 Use of Color        |

### A4. Plan (preview → confirm)

| #    | Step                                           | Expected                                                                                                | WCAG 2.2 AA                   |
| ---- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------- |
| A4.1 | `Tab` to the price input, type a value         | The number input has a visible label + a programmatic hint (`aria-describedby` listing available plans) | 1.3.1; 3.3.2                  |
| A4.2 | Enter an out-of-range (negative) value, submit | Guarded client-side (no request); the field's constraints are clear                                     | 3.3.1; 3.3.3 Error Suggestion |
| A4.3 | Preview, then `Tab` to the confirm-box         | The prorated outcome is announced (`role="status"`); Confirm + Cancel are reachable                     | 4.1.3; 2.1.1                  |
| A4.4 | Cancel the confirm-box with the keyboard       | The box dismisses; focus returns to a sensible place (not lost to `<body>`)                             | 2.4.3                         |

### A5. Payment method (Stripe Elements)

| #    | Step                                  | Expected                                                                                         | WCAG 2.2 AA                    |
| ---- | ------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------ |
| A5.1 | Navigate to Payment method            | The "Card details" label is associated; the Stripe iframe is reachable by keyboard               | 1.3.1; 2.1.1                   |
| A5.2 | No-gateway error state                | The failure is in a `role="alert"`; Save card is disabled until ready (not a silent dead button) | 3.3.1; 4.1.2 Name, Role, Value |
| A5.3 | Tab into and out of the Stripe iframe | No keyboard trap entering/leaving the embedded field                                             | 2.1.2                          |

### A6. Danger zone — modals (focus management is the crux)

| #    | Step                                                | Expected                                                                                                                              | WCAG 2.2 AA                                |
| ---- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| A6.1 | Open the **Cancel** modal                           | Focus moves **into** the dialog (first focusable element); the dialog is `role="dialog"` `aria-modal="true"`, labelled by its heading | 2.4.3; 4.1.2; 2.4.11                       |
| A6.2 | `Tab` / `Shift+Tab` repeatedly inside the modal     | Focus **wraps within** the dialog — it never escapes to the page behind (focus trap)                                                  | 2.1.2; 2.4.3                               |
| A6.3 | Press `Esc`                                         | The modal closes; focus **returns to the trigger button** ("Cancel workspace…")                                                       | 2.1.2; 2.4.3                               |
| A6.4 | Re-open, request a code, enter it, confirm          | The code field has a label + `autocomplete="one-time-code"`; the destructive submit is reachable + disabled until the code is entered | 1.3.1; 1.3.5 Identify Input Purpose; 3.3.2 |
| A6.5 | Open the **Erasure** modal; the typed-confirm field | "Type ERASE to confirm" is labelled; "Email me a code" stays disabled until `ERASE` is typed                                          | 3.3.2; 4.1.2                               |
| A6.6 | Erasure code-entry step + Schedule erasure          | Same focus-trap + Esc + label expectations as A6.1–A6.4                                                                               | 2.1.2; 2.4.3; 1.3.5                        |
| A6.7 | After scheduling, the undo-window status            | The "Erasure scheduled… cancel until <date>" status is in a `role="status"`; the deadline is **text**, not color/icon only            | 4.1.3; 1.4.1                               |
| A6.8 | Data export button                                  | Reachable; the resulting artifact location is announced (`role="status"`), shown as text                                              | 4.1.3                                      |

---

## Part B — Screen-reader checklist (NVDA + VoiceOver)

Run each on the matching platform. For every control verify the SR speaks a meaningful **name**, the
correct **role**, and any **state** (disabled, current, expanded). Mark NVDA and VO independently.

### B1. Structure & navigation (every screen)

- [ ] **Landmarks** present and labelled: `banner` (top bar), `navigation` ("Account sections"),
      `main`. Navigable by the landmark key/rotor. — _1.3.1, 2.4.1_
- [ ] **One `<h1>` per screen** = the section name; headings form a logical outline (`h1` → `h2` →
      `h3`), navigable by heading. — _1.3.1, 2.4.6 Headings & Labels_
- [ ] On a section change, the SR **announces the new heading** (focus is moved to the `<h1>`). —
      _2.4.3, 4.1.3_
- [ ] The **skip link** is announced and works with the SR. — _2.4.1_
- [ ] The active nav item announces its **current** state (`aria-current="page"`). — _4.1.2_
- [ ] Page `lang` is `en` (SR uses the right pronunciation). — _3.1.1 Language of Page_

### B2. Sign in

- [ ] OIDC button announces name + role ("Sign in with your identity provider, button"). — _4.1.2_
- [ ] Token field announces its label + that it's a password/secure field. — _1.3.1, 4.1.2_
- [ ] A login error is **announced** when it appears (live `role="alert"`). — _4.1.3, 3.3.1_

### B3. Read screens (Overview / Billing)

- [ ] Each data **table** announces its **caption** and column headers when navigating cells. —
      _1.3.1_
- [ ] Definition lists (account key/values) read as label → value pairs. — _1.3.1_
- [ ] "Loading…" / empty states are announced (`role="status"`), not silent. — _4.1.3_
- [ ] Money/usage values are intelligible read aloud (e.g. "$5.00", "1h 1m") — not just symbols. —
      _1.3.1_

### B4. Plan

- [ ] Price input announces label + the available-plans hint (`aria-describedby`). — _1.3.1, 3.3.2_
- [ ] The preview/confirm outcome is **announced** as a status when it appears. — _4.1.3_
- [ ] The result message ("Plan updated; charged $25.00") is announced. — _4.1.3_

### B5. Payment method

- [ ] "Card details" label is associated with the Stripe Element. — _1.3.1_
- [ ] Save card announces its **disabled** state until Elements is ready. — _4.1.2_
- [ ] The success/failure message is announced (`role="status"` / `role="alert"`). — _4.1.3_

### B6. Danger zone modals (the highest-risk SR flow)

- [ ] Opening a modal moves SR focus into the dialog and announces it as a **dialog** with its
      **accessible name** (= heading: "Confirm cancellation" / "Permanently erase workspace"). —
      _4.1.2, 2.4.3_
- [ ] The dialog is announced as **modal** (content behind is inert to the SR's reading). — _4.1.2_
- [ ] Within the dialog, every field/button announces name + role + state; the destructive submit
      announces **disabled** until its preconditions are met. — _4.1.2_
- [ ] "Type ERASE to confirm" and the code field announce labels + purpose
      (`autocomplete="one-time-code"`). — _1.3.1, 1.3.5_
- [ ] `Esc` closes the dialog and the SR's focus returns to the trigger (announced). — _2.4.3_
- [ ] The undo-window status ("Erasure scheduled… cancel until <date>") is **announced** and the
      deadline is conveyed in **text**. — _4.1.3, 1.4.1_
- [ ] No information is conveyed by **color alone** anywhere in the Danger zone (the danger styling is
      reinforced by text/labels). — _1.4.1_

### B7. Preferences

- [ ] With OS **reduced-motion** on, no spinner/transition causes motion discomfort (CSS honors
      `prefers-reduced-motion`). — _2.3.3 Animation from Interactions_
- [ ] **Dark/light** follow `prefers-color-scheme` by default; the in-app toggle persists and contrast
      holds in both. — _1.4.3 Contrast (Minimum)_

---

## Results log (fill in when executed)

| Pass              | Tester | Date  | Browser / SR  | Result        | Issues filed |
| ----------------- | ------ | ----- | ------------- | ------------- | ------------ |
| Keyboard-only     | _TBD_  | _TBD_ | _TBD_         | ☐ pass ☐ fail | _link_       |
| NVDA (Windows)    | _TBD_  | _TBD_ | Chrome + NVDA | ☐ pass ☐ fail | _link_       |
| VoiceOver (macOS) | _TBD_  | _TBD_ | Safari + VO   | ☐ pass ☐ fail | _link_       |

> Re-run this plan after any change to the SPA shell, routing/focus management, modals, or the Danger
> zone, and before flipping the destructive feature flag on in production.

## References

- WCAG 2.2 — w3.org/TR/WCAG22; WAI-ARIA APG (dialog pattern) — w3.org/WAI/ARIA/apg/patterns/dialog.
- WebAIM screen-reader testing; `@rules/topic-accessibility.md`.
