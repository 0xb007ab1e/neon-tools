/**
 * A metric/overview tile in the Cloudflare dashboard style: a big value with a label and optional
 * helper line. Used in a responsive grid on overview pages.
 *
 * Accessibility: the label precedes the value in the DOM and is associated with it, so a screen
 * reader announces "<label>: <value>". Purely presentational — no logic.
 */
export function StatTile(props: {
  label: string;
  value: React.ReactNode;
  /** Optional sub-line (e.g. a unit, period, or trend note). */
  hint?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="cf-stat">
      <span className="cf-stat-label">{props.label}</span>
      <span className="cf-stat-value">{props.value}</span>
      {props.hint !== undefined && <span className="cf-stat-hint">{props.hint}</span>}
    </div>
  );
}

/** A responsive grid wrapper for {@link StatTile}s. */
export function StatGrid(props: { children: React.ReactNode }): React.ReactElement {
  return <div className="cf-stat-grid">{props.children}</div>;
}
