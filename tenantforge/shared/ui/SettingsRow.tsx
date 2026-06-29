/**
 * THE Cloudflare account-settings pattern: a row with a **label + helper/description on the left**
 * and the **current value + a control (Edit / toggle / link) on the right**. Grouped inside a `Card`
 * with a section heading.
 *
 * Contextual help (the primary mechanism): pass `description` for discoverable helper text under the
 * label explaining the control/its consequences, and/or `info` for a terse inline {@link InfoTip}
 * ("what is this?") next to the label. Every setting should explain what it does — especially
 * destructive ones — and a disabled control should explain *why* (use `description`/the control's own
 * `title`).
 *
 * Accessibility: the label is associated with the control by passing `htmlFor`/`controlId` where the
 * right side is a single labelable control; otherwise the row exposes its label text adjacent to the
 * control so it reads correctly. Keyboard + visible focus come from the shared token focus stroke on
 * whatever control the caller places in `control`. This component is layout only — it makes no
 * security decision (any gating/mutation authorization is server-side).
 */
export function SettingsRow(props: {
  label: string;
  /** Optional helper/description under the label — the primary, most-discoverable explanation. */
  description?: React.ReactNode;
  /** Optional terse inline "what is this?" help (an {@link InfoTip}) shown next to the label. */
  info?: React.ReactNode;
  /** The current value (rendered to the left of the control). */
  value?: React.ReactNode;
  /** The right-side control (a button, link, toggle, etc.). */
  control?: React.ReactNode;
  /** If the control is a single labelable field, its id (associates the visible label with it). */
  controlId?: string;
}): React.ReactElement {
  const descId = props.controlId !== undefined ? `${props.controlId}-desc` : undefined;
  return (
    <div className="cf-row">
      <div className="cf-row-text">
        {props.controlId !== undefined ? (
          <label className="cf-row-label" htmlFor={props.controlId}>
            {props.label}
          </label>
        ) : (
          <span className="cf-row-label">{props.label}</span>
        )}
        {props.info !== undefined && <span className="cf-row-info">{props.info}</span>}
        {props.description !== undefined && (
          <p id={descId} className="cf-row-desc">
            {props.description}
          </p>
        )}
      </div>
      <div className="cf-row-control">
        {props.value !== undefined && <span className="cf-row-value">{props.value}</span>}
        {props.control}
      </div>
    </div>
  );
}
