import type { Crumb } from './types.js';

/**
 * A breadcrumb trail in the Cloudflare dashboard style.
 *
 * Renders a `<nav aria-label="Breadcrumb">` wrapping an ordered list; the final crumb is the current
 * page and is marked `aria-current="page"` and rendered as plain text (not a link). Separators are
 * decorative (`aria-hidden`).
 */
export function Breadcrumbs(props: { items: readonly Crumb[] }): React.ReactElement {
  return (
    <nav aria-label="Breadcrumb" className="cf-breadcrumbs">
      <ol>
        {props.items.map((c, i) => {
          const isLast = i === props.items.length - 1;
          return (
            <li key={`${c.label}-${i}`}>
              {c.href !== undefined && !isLast ? (
                <a href={c.href}>{c.label}</a>
              ) : (
                <span aria-current={isLast ? 'page' : undefined}>{c.label}</span>
              )}
              {!isLast && (
                <span className="cf-breadcrumb-sep" aria-hidden="true">
                  /
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
