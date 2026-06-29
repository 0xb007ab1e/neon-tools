import type { TabItem } from './types.js';

/**
 * Sub-navigation tabs within a section, in the Cloudflare dashboard style.
 *
 * Implemented as a labelled `<nav>` of links (not the ARIA tabs widget): in these consoles a "tab" is
 * really in-page sub-navigation backed by hash routes, so links with `aria-current="page"` are the
 * correct, simplest semantics (no roving tabindex needed; back/forward + deep-link work). Each tab is
 * keyboard-operable as a normal link with the shared focus stroke.
 */
export function Tabs(props: {
  label: string;
  items: readonly TabItem[];
  activeId: string;
  /** Build the href for a tab (e.g. `(id) => '#/billing/' + id`). */
  href: (id: string) => string;
  /** Optional click handler (e.g. to navigate without a full hashchange round-trip). */
  onSelect?: (id: string) => void;
}): React.ReactElement {
  return (
    <nav aria-label={props.label} className="cf-tabs">
      <ul>
        {props.items.map((t) => (
          <li key={t.id}>
            <a
              href={props.href(t.id)}
              className="cf-tab"
              aria-current={t.id === props.activeId ? 'page' : undefined}
              onClick={
                props.onSelect !== undefined
                  ? (e) => {
                      e.preventDefault();
                      props.onSelect?.(t.id);
                    }
                  : undefined
              }
            >
              {t.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
