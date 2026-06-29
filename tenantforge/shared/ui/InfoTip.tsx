import { useCallback, useEffect, useId, useRef, useState } from 'react';

/**
 * An accessible contextual-help trigger: a small focusable ⓘ button that reveals a short explanation.
 *
 * Built for a11y first (naive hover-only tooltips fail keyboard + touch users):
 * - **Keyboard + touch:** a real `<button>` — Enter/Space/tap **toggle** the bubble; it also opens on
 *   hover/focus for pointer users.
 * - **WCAG 1.4.13 (content on hover/focus):** the bubble is **dismissible** (Esc, or click outside)
 *   without moving the pointer, **hoverable** (moving the pointer from the trigger onto the bubble
 *   keeps it open — a small grace timeout bridges the gap), and **persistent** (it stays until the
 *   user dismisses it / focus leaves the widget — it does not auto-hide on a timer).
 * - **4.1.2 name/role/value + SR:** the trigger has an accessible name (`label`, default
 *   "More information"); the visible bubble is wired so the trigger is `aria-describedby` the bubble,
 *   so a screen reader announces the help text. The bubble is `role="tooltip"`.
 *
 * Presentational + self-contained; no app logic, no I/O. Place it next to a label, header, column
 * heading, status pill, or disabled control to answer "what is this?" in terse text.
 */
export function InfoTip(props: {
  /** The help text revealed in the bubble. */
  children: React.ReactNode;
  /** Accessible name for the trigger button (what it explains). Default: "More information". */
  label?: string;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const bubbleId = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  // Grace timer so moving the pointer from the trigger onto the bubble doesn't close it (hoverable).
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCloseTimer = useCallback(() => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  const scheduleClose = useCallback(() => {
    clearCloseTimer();
    closeTimer.current = setTimeout(() => setOpen(false), 120);
  }, [clearCloseTimer]);
  const openNow = useCallback(() => {
    clearCloseTimer();
    setOpen(true);
  }, [clearCloseTimer]);

  // Esc dismisses; an outside click/focus closes. Both keep the pointer where it is (1.4.13 dismissible).
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    const onDocPointer = (e: Event): void => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onDocPointer, true);
    document.addEventListener('focusin', onDocPointer, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onDocPointer, true);
      document.removeEventListener('focusin', onDocPointer, true);
    };
  }, [open]);

  useEffect(() => clearCloseTimer, [clearCloseTimer]);

  return (
    <span className="cf-infotip" ref={rootRef} onMouseEnter={openNow} onMouseLeave={scheduleClose}>
      <button
        type="button"
        className="cf-infotip-trigger"
        aria-label={props.label ?? 'More information'}
        aria-expanded={open}
        aria-describedby={open ? bubbleId : undefined}
        onClick={() => setOpen((o) => !o)}
        onFocus={openNow}
        onBlur={scheduleClose}
      >
        <span aria-hidden="true">{'\u{2139}'}</span>
      </button>
      {open && (
        <span
          id={bubbleId}
          role="tooltip"
          className="cf-infotip-bubble"
          onMouseEnter={openNow}
          onMouseLeave={scheduleClose}
        >
          {props.children}
        </span>
      )}
    </span>
  );
}
