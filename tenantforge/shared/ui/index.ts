/**
 * Cloudflare-dashboard-style shell components, shared across TenantForge SPAs (portal now, dashboard
 * next). Presentational + prop-driven, Fluent-token-styled (light/dark + reduced-motion via
 * `shared/fluent-tokens.css`), WCAG 2.2 AA, semantic-HTML-first. They hold no app/business logic and
 * make no security decisions — the client is untrusted; authZ/CSRF/tenant scoping stay server-side.
 *
 * See `shared/ui/cf-shell.css` for the styles and docs/design/fluent-design-system.md for the catalog.
 */
export { AppShell } from './AppShell.js';
export { Sidebar } from './Sidebar.js';
export { TopBar } from './TopBar.js';
export { Breadcrumbs } from './Breadcrumbs.js';
export { Tabs } from './Tabs.js';
export { Card } from './Card.js';
export { SettingsRow } from './SettingsRow.js';
export { StatTile, StatGrid } from './StatTile.js';
export { DataTable, type Column } from './DataTable.js';
export { Pill } from './Pill.js';
export { InfoTip } from './InfoTip.js';
export { FormField, type FieldControlProps } from './FormField.js';
export type { NavItem, NavGroup, PillTone, Crumb, TabItem } from './types.js';
