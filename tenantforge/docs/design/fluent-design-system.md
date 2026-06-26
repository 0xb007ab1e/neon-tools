# TenantForge — Fluent Design 2 Design System

Status: **all three SPAs reskinned** — dashboard (slice 1), portal (slice 2), signup (slice 3) each
consume the shared `fluent-tokens.css`.

This document describes the TenantForge design-token system: a [Fluent Design 2](https://fluent2.microsoft.design)
token set built around the brand accent **#FE6601**, the light/dark themes, the **measured WCAG 2.2 AA
contrast ratios** for every key pairing, and how the three SPAs consume the shared tokens.

---

## 1. Shared-token mechanism

The three SPAs (`dashboard/`, `portal/`, `signup/`) are **separate Vite apps**, each with its own
`src/styles.css`. The lowest-friction sharing mechanism for that layout is a **single CSS file** that
each app imports:

```
tenantforge/shared/fluent-tokens.css      ← single source of truth (this slice)
tenantforge/dashboard/src/styles.css      ← @import url('../../shared/fluent-tokens.css'); (slice 1 — DONE)
tenantforge/portal/src/styles.css         ← @import url('../../shared/fluent-tokens.css'); (slice 2 — DONE)
tenantforge/signup/src/styles.css         ← @import url('../../shared/fluent-tokens.css'); (slice 3 — DONE)
```

Each SPA's stylesheet puts the `@import` at the **top** of its `styles.css`. **Vite inlines CSS
`@import` at build time** into a single stylesheet — there is no extra HTTP request at runtime and no
JavaScript involved, so it is **CSP-safe** (no inline styles, no `unsafe-inline`). The shared file only
defines CSS custom properties (`--*`) and theme rules; each app then maps those primitives onto its own
component classes, so apps stay visually consistent without sharing component CSS.

Why not a JS/TS module or a CSS-in-JS package? Those add a build/runtime dependency and (for CSS-in-JS)
risk inline styles that fight CSP. A plain shared `.css` of custom properties is the smallest, most
portable, framework-agnostic contract across three independent Vite apps.

> Verified: `pnpm dashboard:build` inlines the tokens into the emitted CSS (the bundle contains
> `--accent-110:#b24701`, `#fe6601`, `--on-accent`, and **zero** leftover `@import` statements).

---

## 2. The #FE6601 accent ramp

A Fluent-style 16-step ramp derived from the base brand color by mixing toward white (tints) and black
(shades), keeping the hue. Base **#FE6601** sits at step **80**.

| Token              | Hex           | vs white   | vs black   | Typical role                                 |
| ------------------ | ------------- | ---------- | ---------- | -------------------------------------------- |
| `--accent-10`      | `#fff0e6`     | 1.11:1     | 18.86:1    | lightest tint / wash                         |
| `--accent-20`      | `#ffddc7`     | 1.28:1     | 16.42:1    | `--accent-selected` (light)                  |
| `--accent-30`      | `#ffc8a4`     | 1.49:1     | 14.05:1    | tint                                         |
| `--accent-40`      | `#ffb380`     | 1.75:1     | 12.01:1    | tint                                         |
| `--accent-50`      | `#fe9d5c`     | 2.06:1     | 10.19:1    | dark-mode accent text/focus                  |
| `--accent-60`      | `#fe8b3e`     | 2.34:1     | 8.98:1     | dark-mode pressed fill                       |
| `--accent-70`      | `#fe781f`     | 2.65:1     | 7.92:1     | dark-mode hover fill                         |
| **`--accent-80`**  | **`#fe6601`** | **2.95:1** | **7.12:1** | **BASE BRAND** (decorative; dark-mode fill)  |
| `--accent-90`      | `#e55c01`     | 3.58:1     | 5.86:1     | shade                                        |
| `--accent-100`     | `#cb5201`     | 4.42:1     | 4.75:1     | shade                                        |
| **`--accent-110`** | **`#b24701`** | **5.53:1** | 3.79:1     | **light primary fill / accent text / focus** |
| `--accent-120`     | `#983d01`     | 6.99:1     | 3.00:1     | light hover fill                             |
| `--accent-130`     | `#7f3301`     | 8.84:1     | 2.38:1     | light pressed fill                           |
| `--accent-140`     | `#612700`     | 11.68:1    | 1.80:1     | deep shade                                   |
| `--accent-150`     | `#421b00`     | 15.13:1    | 1.39:1     | deep shade                                   |
| `--accent-160`     | `#240e00`     | 18.46:1    | 1.14:1     | darkest shade                                |

### The #FE6601 accessibility trap

**White text on the bright base `#fe6601` is only 2.95:1 — it FAILS WCAG AA** (needs ≥4.5:1 for normal
text, ≥3:1 for large/UI). So the system never puts light text on the bright base in light mode. Two
accessible strategies are used:

1. **Light theme:** the text-bearing primary fill is **`--accent-fill = --accent-110` (`#b24701`)** with
   **white** text → **5.53:1 (PASS)**. Accent-colored text/links and the focus stroke also use
   `--accent-110`.
2. **Dark theme:** dark-on-bright reads better than light-on-bright, so the fill is the **bright base
   `#fe6601`** with **near-black** text (`#1b1a19`) → **5.89:1 (PASS)**. Accent text/links/focus use the
   brighter tint `--accent-50` (`#fe9d5c`) which is high-contrast on dark surfaces.

The bright base `#fe6601` (`--accent`) is still used for **decorative, non-text** brand elements (the
panel-title accent bar, the nav selected-tab underline, the brand-mark swatch — whose "TF" glyph is
`aria-hidden`).

---

## 3. Semantic role tokens

Light theme (defaults), mapped onto Fluent surfaces/neutrals/states:

| Role token                      | Light value           | Notes                                     |
| ------------------------------- | --------------------- | ----------------------------------------- |
| `--bg`                          | `#faf9f8` (neutral-2) | page background                           |
| `--surface`                     | `#ffffff`             | card / panel                              |
| `--surface-2`                   | `#f3f2f1`             | table header, subtle fills                |
| `--surface-3`                   | `#edebe9`             | pressed subtle                            |
| `--fg`                          | `#1b1a19`             | body text (17.4:1 on surface)             |
| `--fg-muted`                    | `#605e5c`             | secondary text (6.5:1 on surface)         |
| `--border` / `--border-strong`  | `#e1dfdd` / `#c8c6c4` | strokes                                   |
| `--accent`                      | `#fe6601`             | brand swatch (decorative)                 |
| `--accent-fill`                 | `#b24701`             | primary-button fill (+`--on-accent` #fff) |
| `--accent-text` / `--focus`     | `#b24701`             | accent links / focus stroke               |
| `--success-fg` / `--success-bg` | `#0e6027` / `#dff6e6` |                                           |
| `--warning-fg` / `--warning-bg` | `#8a5a00` / `#fdf3d7` |                                           |
| `--danger-fg` / `--danger-bg`   | `#b3261e` / `#fdeceb` |                                           |
| `--info-fg` / `--info-bg`       | `#0a5dc2` / `#e3f0fd` |                                           |

Also defined: type ramp (`--fs-caption` … `--fs-large-title`, `--font-base` Segoe UI/system stack,
`--font-mono`), corner radii (`--radius-sm` = 4px Fluent default → `--radius-xl`/`--radius-circular`),
4px-grid spacing (`--sp-1` … `--sp-7`), elevation (`--shadow-2/4/8/16`), and motion
(`--motion-fast/normal/slow` + `--ease-standard/accelerate/decelerate`).

---

## 4. Themes — light + dark + reduced motion

- **Light is the default** (`:root`).
- **Dark** applies when the user explicitly chose it (`:root[data-theme='dark']`, set by the in-app
  theme toggle, persisted to `localStorage` as `tf-theme`) **OR** the OS `prefers-color-scheme: dark`
  and the user has not explicitly chosen light (`:root:not([data-theme='light'])`). This matches the
  dashboard's existing `useTheme()` behavior — no JS change was needed.
- **Reduced motion:** each consuming stylesheet curtails transitions/animations under
  `@media (prefers-reduced-motion: reduce)` (the dashboard sets all durations to ~0 and disables
  smooth scroll). Motion tokens exist for the default case; they are effectively neutralized for users
  who request reduced motion.

---

## 5. Measured AA contrast ratios (key pairings)

All measured with the WCAG 2.x relative-luminance formula. **AA needs ≥4.5:1 for normal text, ≥3:1 for
large text and UI component strokes (1.4.11).** Every shipped pairing passes.

### Light theme

| Pairing                                                | Ratio         | Result    |
| ------------------------------------------------------ | ------------- | --------- |
| body text `#1b1a19` on surface `#ffffff`               | 17.38:1       | PASS      |
| muted text `#605e5c` on surface                        | 6.46:1        | PASS      |
| **primary button: white on `--accent-fill` `#b24701`** | **5.53:1**    | **PASS**  |
| primary button hover (white on `#983d01`)              | 6.99:1        | PASS      |
| primary button pressed (white on `#7f3301`)            | 8.84:1        | PASS      |
| accent text / link `#b24701` on surface                | 5.53:1        | PASS      |
| focus stroke `#b24701` on bg `#faf9f8`                 | 5.26:1        | PASS (≥3) |
| success `#0e6027` on surface / on `--success-bg`       | 7.72 / 6.78:1 | PASS      |
| warning `#8a5a00` on surface / on `--warning-bg`       | 5.93 / 5.36:1 | PASS      |
| danger `#b3261e` on surface / on `--danger-bg`         | 6.54 / 5.72:1 | PASS      |
| info `#0a5dc2` on surface / on `--info-bg`             | 6.25 / 5.41:1 | PASS      |

### Dark theme

| Pairing                                                               | Ratio         | Result    |
| --------------------------------------------------------------------- | ------------- | --------- |
| body text `#f3f2f1` on bg `#1b1a19`                                   | 15.54:1       | PASS      |
| muted text `#c8c6c4` on surface `#242322`                             | 9.21:1        | PASS      |
| **primary button: near-black `#1b1a19` on `--accent-fill` `#fe6601`** | **5.89:1**    | **PASS**  |
| primary button hover (near-black on `#fe781f`)                        | 6.55:1        | PASS      |
| accent text / link `#fe9d5c` on surface                               | 7.61:1        | PASS      |
| focus stroke `#fe9d5c` on bg `#1b1a19`                                | 8.43:1        | PASS (≥3) |
| success `#6cd690` on surface / on `--success-bg`                      | 8.71 / 7.93:1 | PASS      |
| warning `#f5c451` on surface / on `--warning-bg`                      | 9.64 / 8.27:1 | PASS      |
| danger `#ff9a8d` on surface / on `--danger-bg`                        | 7.66 / 7.82:1 | PASS      |
| info `#7cb6ff` on surface / on `--info-bg`                            | 7.47 / 7.15:1 | PASS      |

### The rejected pairing (documented so it isn't re-introduced)

| Pairing                             | Ratio      | Result                |
| ----------------------------------- | ---------- | --------------------- |
| white text on bright base `#fe6601` | **2.95:1** | **FAIL — do not use** |

---

## 6. How the dashboard consumes it

`dashboard/src/styles.css` starts with `@import url('../../shared/fluent-tokens.css');` and then maps
the shared role tokens onto the existing component classes (`.topbar`, `.nav-link`, `.card`, `.panel`,
`table`, `.btn-primary`, `.btn-ghost`, `input`, `.status-*`, `.error`, focus). **No DOM/markup
changed** — it is a pure reskin, so the dashboard's `vitest-axe` assertions and component tests
(`dashboard/test/App.test.tsx`) continue to pass unchanged. The dashboard's existing `useTheme()` hook
(toggle + `data-theme` + `prefers-color-scheme` fallback) drives the shared theme rules with no JS
change.

---

## 7. How the portal & signup consume it (slices 2 & 3)

Both the **portal** (`portal/src/styles.css`) and the public **signup** (`signup/src/styles.css`)
prepend the same `@import url('../../shared/fluent-tokens.css');`. Rather than rewriting every rule,
each **remaps its local role names onto the shared tokens** in `:root` — so all existing selectors
render Fluent with **no markup change** (the portal's 29 `vitest-axe`/component tests and the signup
suite still pass):

```
--panel: var(--surface);   --muted: var(--fg-muted);
--accent: var(--accent-fill);   --accent-fg: var(--on-accent);   /* AA-safe: never white on #fe6601 */
--error: var(--danger-fg);   --ok: var(--success-fg);
/* portal only: --danger: var(--danger-fg); text on the solid danger fill = var(--on-accent) */
/* --bg / --fg / --border / --focus flow straight through from the shared file (light/dark + focus) */
```

Light/dark and reduced-motion come from the shared file: the portal's `data-theme` toggle drives
`:root[data-theme='dark']`; the signup (no toggle) follows `prefers-color-scheme`. The bright base
`#fe6601` is never used under white text on either surface — interactive accent always resolves to the
AA-safe `--accent-fill`/`--on-accent` pair.

## 8. Cloudflare-dashboard shell components (`shared/ui/*`)

The consoles use a **Cloudflare-dashboard-style** shell: a persistent left sidebar + top account bar

- a gray content region of cards. The reusable building blocks live in `shared/ui/*.tsx` and are
  **consumed by multiple SPAs** (the portal now; the dashboard next). They are presentational,
  prop-driven, TS-strict, semantic-HTML-first, and styled entirely with the Fluent tokens via
  `shared/ui/cf-shell.css` (which `@import`s the token file), so light/dark + reduced-motion + the
  AA-safe accent pairs all carry over. They hold **no app/business logic and make no security
  decision** — the client is untrusted; authZ/CSRF/tenant scoping stay server-side.

| Component               | Role                                                                                                                                                                                                        | Key a11y                                                                                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AppShell`              | Layout: skip-link → `Sidebar` + `TopBar` + a single `<main id="main" tabIndex=-1>`. Owns + persists sidebar-collapse.                                                                                       | `<main>` landmark + skip link; consumer focuses `main`/heading on route change.                                                                                                            |
| `Sidebar`               | Collapsible left `<nav>`: brand at top, grouped items (icon + label), active via `aria-current="page"`.                                                                                                     | `<nav>` landmark; items are real `<a>` links; collapse `<button aria-expanded aria-controls>`; collapsed labels stay the link's accessible name (icons `aria-hidden`).                     |
| `TopBar`                | `<header>` with account/context label, optional search slot, right-aligned actions.                                                                                                                         | Header landmark; controls passed by the app.                                                                                                                                               |
| `Breadcrumbs`           | `<nav aria-label="Breadcrumb">` trail; last crumb `aria-current="page"`.                                                                                                                                    | Separators `aria-hidden`.                                                                                                                                                                  |
| `Tabs`                  | Section sub-nav as links with `aria-current` (hash-routed, not the ARIA tabs widget).                                                                                                                       | Labelled `<nav>`; keyboard = normal links.                                                                                                                                                 |
| `Card`                  | Titled surface (header: title + helper + optional actions) on the gray bg.                                                                                                                                  | Labelled `<section>` (`aria-labelledby`); configurable heading level keeps the outline correct.                                                                                            |
| `SettingsRow`           | THE Cloudflare pattern: label + helper left, value + control right. Optional `description` (helper text) + `info` (inline `InfoTip`).                                                                       | `controlId` associates the visible label with a single control via `<label for>`; the `info` tip sits outside the `<label>`.                                                               |
| `StatTile` / `StatGrid` | Metric tiles in a responsive grid (overview). `hint` accepts a node (e.g. an `InfoTip`).                                                                                                                    | Label precedes value.                                                                                                                                                                      |
| `DataTable<T>`          | Generic semantic `<table>`: caption, `scope`d headers, optional `<th scope="row">`, per-row `Pill` + action.                                                                                                | Accessible by construction; empty-state slot.                                                                                                                                              |
| `Pill`                  | Status badge; tone is a token-pair enhancement — **the text inside carries the meaning** (1.4.1).                                                                                                           | Never color-only.                                                                                                                                                                          |
| `InfoTip`               | Focusable ⓘ trigger revealing terse "what is this?" help, for dense controls/headers/status.                                                                                                                | WCAG 1.4.13: keyboard/tap toggle + hover/focus open; **dismissible** (Esc/outside), **hoverable** (grace timeout), **persistent**; trigger `aria-describedby` the `role="tooltip"` bubble. |
| `FormField`             | Input wrapper: visible `<label htmlFor>` + `description` (tied via `aria-describedby`) + optional `info` `InfoTip` + `error` slot. Render-prop hands `{id, aria-describedby, aria-invalid}` to the control. | 3.3.2 labels/instructions; description + error programmatically associated; error is a live `role="alert"`; invalid state mirrored.                                                        |

Sharing mechanism: the same as the tokens — a relative CSS `@import` (`shared/ui/cf-shell.css`,
imported from each SPA's `styles.css`) plus a TS barrel (`shared/ui/index.ts`) imported from the
SPA's React. `shared/tsconfig.json` makes the directory a typecheck + ESLint project (so the
type-checked + React + jsx-a11y rules apply to the shell too).

### Portal redesign (slice: Portal onto the shell)

The portal's old top-nav layout is replaced by `AppShell`. The sidebar groups the sections the
Cloudflare way:

- **(primary)** — Overview
- **Account settings** — Billing · Plan · Payment method
- **Compliance** — Compliance evidence _(only when `features.evidence`)_
- **(danger)** — Danger zone _(only when `features.destructiveActions`; danger-variant styling)_

The flag-gated groups are omitted entirely when their server flag is off, and a deep link to a hidden
section still redirects to Overview. Inside the content region: **Overview** uses `StatTile`s + a
`Card`; **Plan** shows the current price as a `SettingsRow` inside a `Card`; **Billing**, **Payment**,
**Danger**, and **Evidence** are `Card`s; lists (charges/refunds/receipts, evidence manifests) render
via `DataTable`; workspace status shows as a `Pill`. **All behavior is unchanged** — token-mode +
OIDC login, the signed-cookie session, CSRF + idempotency headers on mutations, the step-up modals,
the erasure undo window, and the self-scoped (BOLA-safe) evidence list/download/generate — this was an
IA/layout change, not a logic change. The section title remains the focused `<h1>` on each route
change, and nav items remain `<a aria-current="page">`, so the existing axe + auth/CSRF/flag-gating
assertions hold; the shared components add their own axe + behavior tests (`portal/test/shell.test.tsx`).

### Responsive nav: left-anchored off-canvas drawer (the nav stays LEFT at every width)

The sidebar is **left-anchored and vertical at every viewport width** — never a horizontal top strip.

- **Desktop (≥ 48rem):** a persistent left rail with the collapse-to-rail control (label visually
  hidden when collapsed but kept as each link's accessible name).
- **Narrow (< 48rem):** the sidebar becomes a left **off-canvas drawer** — `position: fixed`,
  `inset-inline-start: 0`, `transform: translateX(-100%)` off-canvas by default, sliding to
  `translateX(0)` when opened over a dim backdrop. A **hamburger** (`☰`, "Open navigation menu")
  appears in the `TopBar` (visible only at this breakpoint) and toggles the drawer. The content
  column takes the full width, so the page **reflows cleanly to 320px / 400% zoom with no horizontal
  page scroll** (WCAG 1.4.10); wide tables keep their own `.cf-table-wrap` `overflow-x:auto`
  container, and **`SettingsRow` stacks** (label/helper above value+control) below 40rem for tappable
  targets.

Drawer a11y (owned by `AppShell`): the hamburger is `<button aria-expanded aria-controls={navId}>`;
opening **moves focus into the drawer** and **traps Tab** within it, **Esc** and a **backdrop click**
close, choosing a nav item closes it, and on close **focus returns to the hamburger**. The drawer is
still the `<nav>` landmark with `aria-current="page"` on the active item, and `prefers-reduced-motion`
disables the slide animation. (The old `< 48rem` top-strip media rules were removed.)

### Dashboard (operator console) onto the shell

The operator dashboard uses the **same** `AppShell` + `Sidebar` + `TopBar` + responsive drawer. Its
four routed sections are unchanged (so routing + the existing tests hold) but the left nav is now
grouped Cloudflare-style:

- **Overview** — Health (operator digest + webhook subscriptions)
- **Fleet & compliance** — Fleet (compliance report, signed evidence bundles, drift, reconcile,
  retention, exports) · Audit (audit log + anomalies)
- **Revenue** — Billing (cost & margin, plans, signup tokens, invoices, charges/dunning/refunds/…)

Active item via `aria-current="page"`; section links keep their names (Health/Fleet/Billing/Audit).
Panel-type mapping: the **Health** digest gains a `StatGrid` of `StatTile`s (overall severity, open
issues, detectors) above its existing headline + detector table; the many **list/table panels**
(drift, reconcile history, cost, invoices, billing events, audit, evidence manifests, retention,
exports, plans, signup tokens, webhooks) keep their existing semantic tables and `status-*`/severity
badges (text-carries-meaning, never color-only). **All behavior is preserved** — operator token auth

- RBAC, the dashboard cookie session, every panel's data fetch + actions including the gated
  reconcile run (capability-checked, `window.confirm`) and the `EvidencePanel` view/download/public-key;
  this was a layout/IA change only. The top bar carries the operator id + role chip + theme toggle +
  sign-out; focus moves to `<main>` on each route change. Dashboard shell tests live in
  `dashboard/test/App.test.tsx` (grouped nav + the responsive drawer focus-trap/Esc/restore), on top of
  the per-section panel + axe tests already there.

### Signup (public flow) — consistency pass, no shell

Signup is a **linear public/anonymous flow, not a console**, so it deliberately keeps **no
sidebar/shell** — `AppShell`/`Sidebar` are not used. It imports the shared shell stylesheet only to
reuse the shared surface/pill look so it visually matches the consoles: the step rail now renders as
**pill chips** (current step accent-filled with the AA-safe `--accent-fill`/`--on-accent` pair; others
neutral — the step name text always carries the meaning, never color-only), and its card/buttons
already map onto the shared tokens. The existing linear flow, focus-on-step-change, captcha/Stripe
steps, and provisioning poll are unchanged.

### Contextual help & natural flow (explain every control; disclose dependent actions)

Every interactive thing carries an explanation, built **accessibility-first** (hover-only tooltips
fail keyboard + touch users):

- **Primary mechanism — inline help.** `FormField` gives every input a visible `<label>` + a
  `description` (what to enter / format) tied via `aria-describedby`, plus an `error` slot announced
  as `role="alert"`. `SettingsRow` takes a `description` (and optional `info`). Inline help is
  cheaper and more discoverable than a tooltip, so it's preferred where space allows.
- **Terse help — `InfoTip`.** A focusable ⓘ for dense controls, headers, columns, and **status
  meaning** (e.g. what each workspace status / digest severity / isolation-residency compliance
  means). It satisfies **WCAG 1.4.13** (dismissible via Esc/outside-click, hoverable via a grace
  timeout, persistent until blur/dismiss), is keyboard- and tap-operable, and wires the trigger
  `aria-describedby` the bubble for screen readers.
- **Actions & disabled controls.** Buttons explain what they do + consequences via `title` (and the
  surrounding copy), especially destructive ones (cancel/erase). A disabled/preview-only control
  **explains why** (e.g. the dashboard reconcile run states it needs the capability + permission and
  points to the CLI).

**Natural flow / progressive disclosure.** Dependent/child actions surface in context rather than
being hidden: the portal Plan flow previews the exact prorated charge/credit inline before a separate
**Confirm** step; cancel/erasure disclose their one-time-code confirmation in a modal and the **undo
window + cancel-erasure** action inline once scheduled; the dashboard reconcile shows the plan (what
would change) before the **Run** action and surfaces the run result via `aria-live`. The primary
action is obvious per view, content reads top→bottom as a sequence, and `Breadcrumbs`/`Tabs` are
available for depth.
