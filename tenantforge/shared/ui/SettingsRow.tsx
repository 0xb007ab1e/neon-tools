/**
 * THE Cloudflare account-settings pattern: a row with a **label + helper/description on the left**
 * and the **current value + a control (Edit / toggle / link) on the right**. Grouped inside a `Card`
 * with a section heading.
 *
 * Accessibility: the label is associated with the control by passing `htmlFor`/`controlId` where the
 * right side is a single labelable control; otherwise the row exposes its label text adjacent to the
 * control so it reads correctly. Keyboard + visible focus come from the shared token focus stroke on
 * whatever control the caller places in `control`. This component is layout only — it makes no
 * security decision (any gating/mutation authorization is server-side).
 */
export function SettingsRow(props: {
  label: string;
  /** Optional helper/description under the label. */
  description?: React.ReactNode;
  /** The current value (rendered to the left of the control). */
  value?: React.ReactNode;
  /** The right-side control (a button, link, toggle, etc.). */
  control?: React.ReactNode;
  /** If the control is a single labelable field, its id (associates the visible label with it). */
  controlId?: string;
}): React.ReactElement {
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
        {props.description !== undefined && <p className="cf-row-desc">{props.description}</p>}
      </div>
      <div className="cf-row-control">
        {props.value !== undefined && <span className="cf-row-value">{props.value}</span>}
        {props.control}
      </div>
    </div>
  );
}
