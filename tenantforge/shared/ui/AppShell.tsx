import { useCallback, useEffect, useRef, useState } from 'react';
import { Sidebar } from './Sidebar.js';
import { TopBar } from './TopBar.js';
import type { NavGroup } from './types.js';

/** Read the persisted sidebar-collapsed preference (best-effort; defaults to expanded). */
function readCollapsed(storageKey: string): boolean {
  try {
    return localStorage.getItem(storageKey) === '1';
  } catch {
    return false;
  }
}

/** Focusable-element selector used to trap focus inside the open drawer. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The Cloudflare-dashboard-style application layout: a persistent **left sidebar** + **top account
 * bar** + a content region, with a **skip link** to the main content.
 *
 * Responsive: the sidebar is **left-anchored and vertical at every width**. On desktop it is a
 * persistent rail (with the collapse-to-rail behavior); on **narrow viewports it is an off-canvas
 * slide-in drawer** opened by a hamburger in the {@link TopBar} (no horizontal top strip), over a dim
 * backdrop. The page reflows cleanly to 320px / 400% zoom with no horizontal page scroll (WCAG 1.4.10).
 *
 * It composes {@link Sidebar} and {@link TopBar} and renders a single `<main>` landmark (id `main`,
 * `tabIndex={-1}` so route changes can move focus into it). The consumer owns routing and focus
 * management for `main`: pass `mainRef` and call `mainRef.current?.focus()` on route change.
 *
 * Drawer a11y (owned here): the hamburger is a `<button aria-expanded aria-controls>`; opening moves
 * focus into the drawer and **traps** it (Tab cycles within), **Esc** and a **backdrop click** close,
 * and on close focus **returns to the hamburger**. `prefers-reduced-motion` is honored in CSS.
 *
 * Layout only — no security decision; the parent decides which nav items to show (e.g. flag-gated
 * sections) and enforces all authorization server-side.
 */
export function AppShell(props: {
  brand: React.ReactNode;
  navGroups: readonly NavGroup[];
  navAriaLabel: string;
  activeId: string;
  href: (id: string) => string;
  onSelect: (id: string) => void;
  topbarContext: React.ReactNode;
  topbarSearch?: React.ReactNode;
  topbarActions?: React.ReactNode;
  /** Accessible label for the `<main>` region (e.g. "Billing section"). */
  mainLabel: string;
  mainRef?: React.Ref<HTMLElement>;
  collapseStorageKey?: string;
  children: React.ReactNode;
}): React.ReactElement {
  const storageKey = props.collapseStorageKey ?? 'tf-sidebar-collapsed';
  const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsed(storageKey));
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, collapsed ? '1' : '0');
    } catch {
      /* ignore persistence failure */
    }
  }, [collapsed, storageKey]);
  const toggleCollapsed = useCallback(() => setCollapsed((c) => !c), []);

  // Narrow-viewport off-canvas drawer state.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const hamburgerRef = useRef<HTMLButtonElement>(null);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  // On open: move focus into the drawer, trap Tab within it, Esc closes; on close (or unmount)
  // restore focus to the hamburger. The backdrop click also closes (handled on the backdrop element).
  useEffect(() => {
    if (!drawerOpen) return;
    const node = navRef.current;
    // Capture the trigger now so cleanup restores focus to the element that opened the drawer
    // (the ref is stable for the component's life, but capturing satisfies the exhaustive-deps lint
    // and is the documented-safe pattern for using a ref in an effect's cleanup).
    const trigger = hamburgerRef.current;
    const items = node?.querySelectorAll<HTMLElement>(FOCUSABLE);
    items?.[0]?.focus();

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setDrawerOpen(false);
        return;
      }
      if (e.key !== 'Tab' || node === null) return;
      const focusable = node.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      trigger?.focus();
    };
  }, [drawerOpen]);

  // Selecting a nav item navigates AND closes the drawer (so it doesn't linger over the content on
  // narrow viewports). Routing itself stays with the parent's onSelect.
  const onSelect = useCallback(
    (id: string) => {
      props.onSelect(id);
      setDrawerOpen(false);
    },
    [props],
  );

  const navToggle = (
    <button
      type="button"
      ref={hamburgerRef}
      className="cf-nav-toggle"
      aria-label="Open navigation menu"
      aria-expanded={drawerOpen}
      aria-controls="cf-sidebar-nav-root"
      onClick={() => setDrawerOpen((o) => !o)}
    >
      <span aria-hidden="true">{'☰'}</span>
    </button>
  );

  return (
    <div
      className={`cf-shell${collapsed ? ' cf-shell-collapsed' : ''}${drawerOpen ? ' cf-shell-drawer-open' : ''}`}
    >
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      {/* Dim backdrop behind the open drawer (narrow only); click closes. Decorative + presentational —
          the drawer is dismissed via Esc / a nav choice / this backdrop / the hamburger. */}
      <div
        className="cf-drawer-backdrop"
        hidden={!drawerOpen}
        onClick={closeDrawer}
        aria-hidden="true"
      />
      <Sidebar
        id="cf-sidebar-nav-root"
        navRef={navRef}
        brand={props.brand}
        groups={props.navGroups}
        activeId={props.activeId}
        ariaLabel={props.navAriaLabel}
        collapsed={collapsed}
        drawerOpen={drawerOpen}
        onToggleCollapsed={toggleCollapsed}
        href={props.href}
        onSelect={onSelect}
      />
      <div className="cf-main-col">
        <TopBar
          navToggle={navToggle}
          context={props.topbarContext}
          search={props.topbarSearch}
          actions={props.topbarActions}
        />
        <main id="main" ref={props.mainRef} tabIndex={-1} aria-label={props.mainLabel}>
          {props.children}
        </main>
      </div>
    </div>
  );
}
