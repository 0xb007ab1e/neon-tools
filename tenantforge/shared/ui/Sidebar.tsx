import type { NavGroup } from './types.js';

/**
 * The persistent left navigation in the Cloudflare dashboard style: a brand/wordmark at the top, then
 * grouped nav items (icon + label), plus a collapse control. It stays **left-anchored and vertical at
 * every width**: a persistent rail on desktop and a left **off-canvas slide-in drawer** on narrow
 * viewports (the page never gets a horizontal top strip).
 *
 * Accessibility:
 * - It is a `<nav>` landmark (labelled via `ariaLabel`); items are real `<a>` links with the
 *   hash route as `href`, and the active item carries `aria-current="page"`.
 * - The collapse toggle is a `<button>` with `aria-expanded` + `aria-controls`, keyboard-operable
 *   (it's a native button — Enter/Space work) with the shared visible focus stroke. When collapsed,
 *   labels are visually hidden but remain the accessible name of each link (icons are aria-hidden),
 *   so the nav is fully usable by AT in either state.
 * - Drawer mode (narrow): when `drawerOpen` is set, the parent ({@link AppShell}) owns the open/close
 *   state, the backdrop, focus trap, Esc-to-close, and focus restore; this component only reflects the
 *   open class + a ref so the parent can trap focus. The `id` lets the parent's hamburger
 *   `aria-controls` point at this nav.
 * - Selecting an item calls `onSelect(id)`; the parent owns routing + focus management.
 */
export function Sidebar(props: {
  brand: React.ReactNode;
  groups: readonly NavGroup[];
  activeId: string;
  ariaLabel: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  href: (id: string) => string;
  onSelect: (id: string) => void;
  /** DOM id for the `<nav>` (so a hamburger's `aria-controls` can reference it). */
  id?: string;
  /** Whether the narrow-viewport off-canvas drawer is open (parent-owned). */
  drawerOpen?: boolean;
  /** Ref to the `<nav>` element (parent uses it to trap focus while the drawer is open). */
  navRef?: React.Ref<HTMLElement>;
}): React.ReactElement {
  const className = [
    'cf-sidebar',
    props.collapsed ? 'cf-sidebar-collapsed' : '',
    props.drawerOpen === true ? 'cf-sidebar-drawer-open' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <nav id={props.id} ref={props.navRef} className={className} aria-label={props.ariaLabel}>
      <div className="cf-sidebar-brand">{props.brand}</div>
      <button
        type="button"
        className="cf-sidebar-collapse"
        aria-expanded={!props.collapsed}
        aria-controls="cf-sidebar-nav"
        onClick={props.onToggleCollapsed}
        title={props.collapsed ? 'Expand navigation' : 'Collapse navigation'}
      >
        <span aria-hidden="true">{props.collapsed ? '»' : '«'}</span>
        <span className="cf-collapse-label">
          {props.collapsed ? 'Expand navigation' : 'Collapse navigation'}
        </span>
      </button>
      <div id="cf-sidebar-nav" className="cf-sidebar-groups">
        {props.groups.map((group, gi) => (
          <div className="cf-nav-group" key={group.heading ?? `group-${gi}`}>
            {group.heading !== undefined && (
              <p className="cf-nav-group-heading" aria-hidden="true">
                {group.heading}
              </p>
            )}
            <ul>
              {group.items.map((item) => (
                <li key={item.id}>
                  <a
                    href={props.href(item.id)}
                    className={`cf-nav-item${item.variant === 'danger' ? ' cf-nav-danger' : ''}`}
                    aria-current={item.id === props.activeId ? 'page' : undefined}
                    onClick={(e) => {
                      e.preventDefault();
                      props.onSelect(item.id);
                    }}
                  >
                    {item.icon !== undefined && (
                      <span className="cf-nav-icon" aria-hidden="true">
                        {item.icon}
                      </span>
                    )}
                    <span className="cf-nav-label">{item.label}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
