import { useId } from 'react';

/** The wiring a `FormField` hands to its control so the label/description/error associate correctly. */
export interface FieldControlProps {
  /** The control's id (matches the `<label htmlFor>`). */
  id: string;
  /** Space-joined ids of the description + error, for the control's `aria-describedby` (or undefined). */
  'aria-describedby': string | undefined;
  /** Mirrors the error state to assistive tech on the control itself. */
  'aria-invalid': boolean | undefined;
}

/**
 * An accessible form-field wrapper: a visible `<label htmlFor>`, an optional description tied to the
 * control via `aria-describedby`, an optional inline `InfoTip` for terse "what is this?", and an
 * optional error slot (announced via `role="alert"` and also referenced by `aria-describedby`).
 *
 * WCAG: 3.3.2 (labels/instructions — every input has a visible label + guidance), 1.3.1/4.1.2
 * (the description + error are programmatically associated, not just visually near), 4.1.3 (the error
 * is a live `role="alert"`). The control is provided by a **render-prop** so the wiring is guaranteed:
 *
 * ```tsx
 * <FormField label="Workspace name" description="lowercase letters, numbers, hyphens">
 *   {(field) => <input {...field} value={slug} onChange={...} />}
 * </FormField>
 * ```
 *
 * Presentational only — no validation logic here (callers pass an `error` string when invalid; the
 * server remains the source of truth for validation).
 */
export function FormField(props: {
  label: React.ReactNode;
  /** Helper/instruction text under the label (the primary, most-discoverable explanation). */
  description?: React.ReactNode;
  /** Terse inline "what is this?" help (an {@link InfoTip}) shown next to the label. */
  info?: React.ReactNode;
  /** Error message; when set, the control is marked invalid and the message is announced. */
  error?: React.ReactNode;
  /** Explicit control id (else auto-generated). */
  id?: string;
  children: (field: FieldControlProps) => React.ReactNode;
}): React.ReactElement {
  const autoId = useId();
  const id = props.id ?? autoId;
  const descId = `${id}-desc`;
  const errId = `${id}-err`;
  const describedBy =
    [props.description !== undefined ? descId : null, props.error !== undefined ? errId : null]
      .filter((x): x is string => x !== null)
      .join(' ') || undefined;

  return (
    <div className="cf-field">
      {/* The InfoTip sits OUTSIDE the <label> (a <label> wrapping a button creates an ambiguous
          label association); the row keeps them visually adjacent. */}
      <span className="cf-field-label-row">
        <label className="cf-field-label" htmlFor={id}>
          {props.label}
        </label>
        {props.info !== undefined && <span className="cf-field-info">{props.info}</span>}
      </span>
      {props.description !== undefined && (
        <p id={descId} className="cf-field-desc">
          {props.description}
        </p>
      )}
      {props.children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': props.error !== undefined ? true : undefined,
      })}
      {props.error !== undefined && (
        <p id={errId} role="alert" className="cf-field-error">
          {props.error}
        </p>
      )}
    </div>
  );
}
