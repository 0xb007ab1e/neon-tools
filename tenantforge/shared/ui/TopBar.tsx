/**
 * The top account/context bar in the Cloudflare dashboard style: an optional leading nav-toggle
 * (the narrow-viewport hamburger), an account/context label, an optional search slot in the middle,
 * and help/profile/theme controls on the right.
 *
 * It is a `<header>` landmark with a labelled region; all interactive children are passed in by the
 * caller (so auth/profile actions stay in the app, not this presentational shell). No logic here.
 * The `navToggle` is rendered first and is only visible on narrow viewports via CSS (`.cf-nav-toggle`).
 */
export function TopBar(props: {
  /** Leading control (the narrow-viewport hamburger that opens the off-canvas nav drawer). */
  navToggle?: React.ReactNode;
  /** Account/context label (e.g. the workspace name). */
  context: React.ReactNode;
  /** Optional search control (rendered centrally). */
  search?: React.ReactNode;
  /** Right-aligned controls (help, theme toggle, profile/sign-out). */
  actions?: React.ReactNode;
}): React.ReactElement {
  return (
    <header className="cf-topbar">
      {props.navToggle}
      <div className="cf-topbar-context">{props.context}</div>
      {props.search !== undefined && <div className="cf-topbar-search">{props.search}</div>}
      {props.actions !== undefined && <div className="cf-topbar-actions">{props.actions}</div>}
    </header>
  );
}
