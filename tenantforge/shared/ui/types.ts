/**
 * Shared types for the Cloudflare-dashboard-style shell components (`shared/ui/*`).
 *
 * These components are consumed by multiple TenantForge SPAs (portal now; dashboard next). They are
 * presentational + prop-driven: they hold no app/business logic, perform no I/O, and make no security
 * decisions (the client is untrusted — authZ/CSRF/tenant scoping stay server-side). They render
 * semantic HTML first and add ARIA only to fill gaps, and they are styled entirely via the shared
 * Fluent tokens (`shared/fluent-tokens.css`), so light/dark + reduced-motion come for free.
 */

/** A single left-sidebar navigation item. */
export interface NavItem {
  /** Stable id (also the hash route fragment, e.g. `overview` → `#/overview`). */
  readonly id: string;
  /** Human-readable label shown next to the icon. */
  readonly label: string;
  /** Optional decorative icon (aria-hidden in the component; the label carries meaning). */
  readonly icon?: React.ReactNode;
  /** Optional extra class for the item (e.g. a danger-styled item). */
  readonly variant?: 'default' | 'danger';
}

/** A grouped set of nav items with an optional section heading (Cloudflare groups its left nav). */
export interface NavGroup {
  /** Optional group heading (rendered as a small uppercase label; omit for an ungrouped block). */
  readonly heading?: string;
  readonly items: readonly NavItem[];
}

/** Status-pill tone, mapped to the shared semantic token pairs (never color-only — text carries it). */
export type PillTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

/** A breadcrumb trail entry. The last entry is the current page (rendered as plain text). */
export interface Crumb {
  readonly label: string;
  /** Optional href; omitted/last crumb renders as the current location (no link). */
  readonly href?: string;
}

/** A sub-navigation tab within a section. */
export interface TabItem {
  readonly id: string;
  readonly label: string;
}
