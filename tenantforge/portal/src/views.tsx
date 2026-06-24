import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  api,
  ApiError,
  type CreditBalance,
  type Invoice,
  type PendingErasure,
  type PlanPreview,
  type TenantEvent,
  type TenantSummary,
  type Usage,
} from './api.js';
import type { Stripe, StripeElements } from './loaders.js';

// --- formatting helpers (display only; pure) -------------------------------------------------------

/** Humanize a byte count to a readable binary unit. */
function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

/** Humanize a duration in seconds to a readable h/m/s string. */
function humanSeconds(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Format minor units (cents) as USD, signed. */
function usdMinor(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  return `${sign}$${(Math.abs(minor) / 100).toFixed(2)}`;
}

/** Format an ISO timestamp for display (locale date+time); the raw string when unparseable. */
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

// --- async-load hook + busy guard -----------------------------------------------------------------

/** Load state for an async fetch: the data, an error message, and whether it's in flight. */
interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Load data on mount (and on demand via `reload`). On a 404 (e.g. a flag-gated endpoint that doesn't
 * exist), `onNotFound` is returned as the data instead of an error — so views degrade gracefully when
 * the server doesn't advertise a capability.
 */
function useLoad<T>(fn: () => Promise<T>, onNotFound?: () => T): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const nfRef = useRef(onNotFound);
  nfRef.current = onNotFound;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fnRef.current().then(
      (d) => {
        if (!cancelled) {
          setData(d);
          setLoading(false);
        }
      },
      (e: unknown) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404 && nfRef.current !== undefined) {
          setData(nfRef.current());
        } else {
          setError(e instanceof Error ? e.message : String(e));
        }
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}

/** Wrap an async action with busy + error state (one in-flight at a time). */
function useAction(): {
  busy: boolean;
  error: string | null;
  run: (fn: () => Promise<void>) => Promise<void>;
  clearError: () => void;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, clearError: useCallback(() => setError(null), []) };
}

// --- shared presentational pieces ------------------------------------------------------------------

/** A standard loading/error/empty wrapper for a loaded panel. */
function Async<T>(props: {
  state: Loaded<T>;
  children: (data: T) => React.ReactNode;
}): React.ReactElement {
  if (props.state.loading) {
    return (
      <p className="status" role="status">
        <span className="spinner" aria-hidden="true" /> Loading…
      </p>
    );
  }
  if (props.state.error !== null) {
    return (
      <p className="alert" role="alert">
        {props.state.error}
      </p>
    );
  }
  if (props.state.data === null) return <p>No data.</p>;
  return <>{props.children(props.state.data)}</>;
}

/** A read-only event table (charges / refunds / receipts). */
function EventsTable(props: {
  caption: string;
  events: TenantEvent[];
  empty: string;
}): React.ReactElement {
  if (props.events.length === 0) return <p>{props.empty}</p>;
  return (
    <table>
      <caption>{props.caption}</caption>
      <thead>
        <tr>
          <th scope="col">When</th>
          <th scope="col">Amount</th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        {props.events.map((e, i) => {
          const ctx = e.context ?? {};
          const amount =
            typeof ctx['amountMinor'] === 'number' ? usdMinor(ctx['amountMinor']) : '—';
          const status = typeof ctx['status'] === 'string' ? ctx['status'] : e.outcome;
          return (
            <tr key={`${e.at}-${i}`}>
              <td>{fmtDate(e.at)}</td>
              <td>{amount}</td>
              <td>{status}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * An accessible modal dialog: focus trap + restore, Escape to close, labelled by its heading. Used
 * for the destructive confirmations. The first focusable element is focused on open; focus returns to
 * the trigger on close (a11y — focus management on modal open/close).
 */
function Modal(props: {
  titleId: string;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusable = node?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    focusable?.[0]?.focus();

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        props.onClose();
        return;
      }
      if (e.key !== 'Tab' || node === null) return;
      const items = node.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
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
      previouslyFocused.current?.focus();
    };
  }, [props]);

  // Backdrop is non-interactive (no click-to-close, which is an unlabelled control for AT users);
  // the dialog is dismissed via Escape or its explicit buttons (focus is trapped within it).
  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={props.titleId}
        ref={ref}
      >
        <h2 id={props.titleId}>{props.title}</h2>
        {props.children}
      </div>
    </div>
  );
}

// --- Overview --------------------------------------------------------------------------------------

/** Overview: the account summary + current-period usage. */
export function OverviewView(): React.ReactElement {
  const me = useLoad<TenantSummary>(() => api.me());
  const usage = useLoad<Usage | null>(
    () => api.usage(),
    // Usage may be unavailable (no metering) — treat a 404 as "no usage" rather than an error.
    () => null,
  );
  return (
    <section aria-labelledby="overview-account">
      <h2 id="overview-account">Account</h2>
      <Async state={me}>
        {(s) => (
          <dl className="kv">
            <dt>Workspace</dt>
            <dd>{s.slug}</dd>
            <dt>Status</dt>
            <dd>{s.status}</dd>
            <dt>Region</dt>
            <dd>{s.region}</dd>
            <dt>Member since</dt>
            <dd>{fmtDate(s.createdAt)}</dd>
            {s.planPriceUsd !== undefined && (
              <>
                <dt>Plan</dt>
                <dd>${s.planPriceUsd.toFixed(2)} / period</dd>
              </>
            )}
          </dl>
        )}
      </Async>
      <h2>Usage this period</h2>
      <Async state={usage}>
        {(u) =>
          u === null ? (
            <p>Usage metering is not available for your workspace.</p>
          ) : (
            <table>
              <caption>
                Usage ({fmtDate(u.period.from)} – {fmtDate(u.period.to)})
              </caption>
              <thead>
                <tr>
                  <th scope="col">Metric</th>
                  <th scope="col">Amount</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Compute time</td>
                  <td>{humanSeconds(u.consumption.computeTimeSeconds)}</td>
                </tr>
                <tr>
                  <td>Active time</td>
                  <td>{humanSeconds(u.consumption.activeTimeSeconds)}</td>
                </tr>
                <tr>
                  <td>Data written</td>
                  <td>{humanBytes(u.consumption.writtenDataBytes)}</td>
                </tr>
                <tr>
                  <td>Storage (peak)</td>
                  <td>{humanBytes(u.consumption.syntheticStorageBytes)}</td>
                </tr>
              </tbody>
            </table>
          )
        }
      </Async>
    </section>
  );
}

// --- Billing ---------------------------------------------------------------------------------------

/** Billing: invoices, charges, refunds, receipts, and the credit balance. */
export function BillingView(): React.ReactElement {
  const invoices = useLoad<Invoice[]>(
    () => api.invoices(),
    () => [],
  );
  const charges = useLoad<TenantEvent[]>(
    () => api.charges(),
    () => [],
  );
  const refunds = useLoad<TenantEvent[]>(
    () => api.refunds(),
    () => [],
  );
  const receipts = useLoad<TenantEvent[]>(
    () => api.receipts(),
    () => [],
  );
  const credit = useLoad<CreditBalance>(() => api.creditBalance());
  return (
    <section aria-labelledby="billing-credit">
      <h2 id="billing-credit">Credit balance</h2>
      <Async state={credit}>
        {(c) => (
          <p>
            <strong>{usdMinor(c.balanceMinor)}</strong> {c.currency.toUpperCase()}
          </p>
        )}
      </Async>

      <h2>Invoices</h2>
      <Async state={invoices}>
        {(list) =>
          list.length === 0 ? (
            <p>No invoices yet.</p>
          ) : (
            <>
              {list.map((inv, i) => (
                <table key={`${inv.periodStart}-${i}`}>
                  <caption>
                    {fmtDate(inv.periodStart)} – {fmtDate(inv.periodEnd)} · Total $
                    {inv.totalUsd.toFixed(2)} {inv.currency.toUpperCase()}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Description</th>
                      <th scope="col">Qty</th>
                      <th scope="col">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inv.lineItems.map((li, j) => (
                      <tr key={j}>
                        <td>{li.description}</td>
                        <td>
                          {li.quantity} {li.unit}
                        </td>
                        <td>${li.amountUsd.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ))}
            </>
          )
        }
      </Async>

      <h2>Recent charges</h2>
      <Async state={charges}>
        {(e) => <EventsTable caption="Charges" events={e} empty="No charges yet." />}
      </Async>
      <h2>Recent refunds</h2>
      <Async state={refunds}>
        {(e) => <EventsTable caption="Refunds" events={e} empty="No refunds yet." />}
      </Async>
      <h2>Recent receipts</h2>
      <Async state={receipts}>
        {(events) =>
          events.length === 0 ? (
            <p>No receipts yet.</p>
          ) : (
            <table>
              <caption>Receipts</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Reference</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e, i) => {
                  const ctx = e.context ?? {};
                  return (
                    <tr key={`${e.at}-${i}`}>
                      <td>{fmtDate(e.at)}</td>
                      <td>{typeof ctx['kind'] === 'string' ? ctx['kind'] : '—'}</td>
                      <td>{typeof ctx['reference'] === 'string' ? ctx['reference'] : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        }
      </Async>
    </section>
  );
}

// --- Plan ------------------------------------------------------------------------------------------

/** Plan: show the catalog + current price, preview a change, then confirm + apply (idempotent). */
export function PlanView(): React.ReactElement {
  const plan = useLoad(() => api.plan());
  const [target, setTarget] = useState<string>('');
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const action = useAction();
  const previewId = useId();

  const doPreview = (e: React.FormEvent): void => {
    e.preventDefault();
    const price = Number(target);
    if (!Number.isFinite(price) || price < 0) return;
    setConfirmed(null);
    void action.run(async () => {
      setPreview(await api.previewPlan(price));
    });
  };

  const doChange = (): void => {
    if (preview === null) return;
    // A stable idempotency key for this confirmed change so a retry can't double-settle (F3a).
    const key = `plan-${preview.newPriceUsd}-${preview.period.from}`;
    void action.run(async () => {
      const report = await api.changePlan(preview.newPriceUsd, key);
      setConfirmed(
        report.settlement === 'none'
          ? 'Plan updated.'
          : `Plan updated; ${report.settlement} ${usdMinor(Math.abs(report.proratedDeltaMinor))}.`,
      );
      setPreview(null);
      plan.reload();
    });
  };

  return (
    <section aria-labelledby="plan-current">
      <h2 id="plan-current">Your plan</h2>
      <Async state={plan}>
        {(p) => (
          <>
            <p>
              Current price:{' '}
              <strong>
                {p.current === null ? 'no plan set' : `$${p.current.toFixed(2)} / period`}
              </strong>
            </p>
            <form onSubmit={doPreview}>
              <label htmlFor="new-price">New plan price (USD per period)</label>
              <input
                id="new-price"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                required
                aria-describedby={previewId}
              />
              {p.available.length > 0 && (
                <p id={previewId} className="hint">
                  Available plans: {p.available.map((a) => `$${a.priceUsd}`).join(', ')}
                </p>
              )}
              <button type="submit" disabled={action.busy || target === ''}>
                {action.busy && <span className="spinner" aria-hidden="true" />}
                Preview change
              </button>
            </form>
          </>
        )}
      </Async>

      {action.error !== null && (
        <p className="alert" role="alert">
          {action.error}
        </p>
      )}
      {confirmed !== null && (
        <p className="ok-note" role="status">
          {confirmed}
        </p>
      )}

      {preview !== null && (
        <div className="confirm-box">
          <h3>Confirm plan change</h3>
          <p role="status">
            Switching from ${preview.oldPriceUsd.toFixed(2)} to ${preview.newPriceUsd.toFixed(2)}.
            {preview.proratedDeltaMinor === 0
              ? ' No prorated charge.'
              : preview.proratedDeltaMinor > 0
                ? ` You will be charged ${usdMinor(preview.proratedDeltaMinor)} now (prorated).`
                : ` You will be credited ${usdMinor(Math.abs(preview.proratedDeltaMinor))} (prorated).`}
          </p>
          <div className="actions">
            <button type="button" onClick={doChange} disabled={action.busy}>
              {action.busy && <span className="spinner" aria-hidden="true" />}
              Confirm change
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setPreview(null)}
              disabled={action.busy}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// --- Payment method --------------------------------------------------------------------------------

/** Payment method: Stripe Elements collects the card; the server verifies the SetupIntent + sets default. */
export function PaymentView(props: {
  loadStripe: (publishableKey: string) => Promise<Stripe>;
}): React.ReactElement {
  const stripeRef = useRef<Stripe | null>(null);
  const elementsRef = useRef<StripeElements | null>(null);
  const setupIntentIdRef = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [done, setDone] = useState(false);
  const action = useAction();
  const [initError, setInitError] = useState<string | null>(null);

  // Open a SetupIntent for this tenant + mount the Stripe Payment Element (PAN never touches us).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const setup = await api.setupIntent();
        if (setup.publishableKey === undefined || setup.publishableKey === '') {
          throw new Error('Payments are not configured for your workspace.');
        }
        const stripe = await props.loadStripe(setup.publishableKey);
        if (cancelled) return;
        const elements = stripe.elements({ clientSecret: setup.clientSecret });
        elements.create('payment').mount('#payment-element');
        stripeRef.current = stripe;
        elementsRef.current = elements;
        setupIntentIdRef.current = setup.setupIntentId;
        setReady(true);
      } catch (e) {
        if (!cancelled) setInitError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props]);

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    const stripe = stripeRef.current;
    const elements = elementsRef.current;
    const setupIntentId = setupIntentIdRef.current;
    if (stripe === null || elements === null || setupIntentId === null) return;
    void action.run(async () => {
      const { error } = await stripe.confirmSetup({ elements, redirect: 'if_required' });
      if (error !== undefined) throw new Error(error.message ?? 'card could not be saved');
      // Idempotent set-default: the server re-reads the intent + verifies customerRef ownership (F5).
      await api.setDefaultPaymentMethod(setupIntentId, `pm-${setupIntentId}`);
      setDone(true);
    });
  };

  return (
    <section aria-labelledby="payment-heading">
      <h2 id="payment-heading">Update payment method</h2>
      <p className="lede">
        Your card is collected securely by Stripe and never touches our servers.
      </p>
      {initError !== null && (
        <p className="alert" role="alert">
          {initError}
        </p>
      )}
      {done ? (
        <p className="ok-note" role="status">
          Your default payment method has been updated.
        </p>
      ) : (
        <form onSubmit={submit}>
          <label htmlFor="payment-element">Card details</label>
          <div id="payment-element" />
          {action.error !== null && (
            <p className="alert" role="alert">
              {action.error}
            </p>
          )}
          <button type="submit" disabled={!ready || action.busy}>
            {action.busy && <span className="spinner" aria-hidden="true" />}
            Save card
          </button>
        </form>
      )}
    </section>
  );
}

// --- Danger zone -----------------------------------------------------------------------------------

/** Danger zone: data export, cancel (step-up), and erasure (typed confirm + step-up + undo window). */
export function DangerZoneView(): React.ReactElement {
  const pending = useLoad<PendingErasure | null>(
    () => api.pendingErasure(),
    () => null,
  );
  return (
    <section aria-labelledby="danger-heading">
      <h2 id="danger-heading">Danger zone</h2>
      <p className="lede">
        These actions affect your whole workspace. Cancel is reversible during a grace window;
        erasure is permanent.
      </p>
      <DataExportPanel />
      <CancelPanel />
      <ErasurePanel pending={pending} />
    </section>
  );
}

/** Data export (DSAR): request an export; show the resulting artifact location. */
function DataExportPanel(): React.ReactElement {
  const action = useAction();
  const [location, setLocation] = useState<string | null>(null);
  return (
    <div className="danger-panel">
      <h3>Export your data</h3>
      <p>Download a copy of your workspace data (portability / DSAR).</p>
      {action.error !== null && (
        <p className="alert" role="alert">
          {action.error}
        </p>
      )}
      {location !== null && (
        <p className="ok-note" role="status">
          Export ready at <code>{location}</code>.
        </p>
      )}
      <button
        type="button"
        disabled={action.busy}
        onClick={() =>
          void action.run(async () => {
            const r = await api.dataExport();
            setLocation(r.location);
          })
        }
      >
        {action.busy && <span className="spinner" aria-hidden="true" />}
        Request data export
      </button>
    </div>
  );
}

/** Cancel (offboard): request a step-up code, enter it in a modal, confirm cancel. */
function CancelPanel(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const action = useAction();
  const titleId = useId();

  const sendCode = (): void =>
    void action.run(async () => {
      await api.requestStepUp('cancel');
      setSent(true);
    });

  const confirm = (e: React.FormEvent): void => {
    e.preventDefault();
    void action.run(async () => {
      const r = await api.cancel(code);
      setResult(`Workspace cancelled. Reversible until ${fmtDate(r.reversibleUntil)}.`);
      setOpen(false);
      setCode('');
      setSent(false);
    });
  };

  return (
    <div className="danger-panel">
      <h3>Cancel workspace</h3>
      <p>
        Stop your workspace. It is retained and reversible during a grace window before deletion.
      </p>
      {result !== null && (
        <p className="ok-note" role="status">
          {result}
        </p>
      )}
      <button type="button" className="danger-button" onClick={() => setOpen(true)}>
        Cancel workspace…
      </button>
      {open && (
        <Modal titleId={titleId} title="Confirm cancellation" onClose={() => setOpen(false)}>
          <p>We’ll email a one-time code to confirm it’s you.</p>
          {action.error !== null && (
            <p className="alert" role="alert">
              {action.error}
            </p>
          )}
          {!sent ? (
            <div className="actions">
              <button type="button" onClick={sendCode} disabled={action.busy}>
                {action.busy && <span className="spinner" aria-hidden="true" />}
                Email me a code
              </button>
              <button type="button" className="secondary" onClick={() => setOpen(false)}>
                Keep my workspace
              </button>
            </div>
          ) : (
            <form onSubmit={confirm}>
              <p role="status">If an email is on file, a code was sent.</p>
              <label htmlFor="cancel-code">Confirmation code</label>
              <input
                id="cancel-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
              />
              <div className="actions">
                <button
                  type="submit"
                  className="danger-button"
                  disabled={action.busy || code === ''}
                >
                  {action.busy && <span className="spinner" aria-hidden="true" />}
                  Cancel workspace
                </button>
                <button type="button" className="secondary" onClick={() => setOpen(false)}>
                  Keep my workspace
                </button>
              </div>
            </form>
          )}
        </Modal>
      )}
    </div>
  );
}

/** Erasure: typed "ERASE" confirmation + step-up code; shows the undo window + a cancel-erasure action. */
function ErasurePanel(props: {
  pending: ReturnType<typeof useLoad<PendingErasure | null>>;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [confirmPhrase, setConfirmPhrase] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const action = useAction();
  const cancelAction = useAction();
  const titleId = useId();
  const pending = props.pending.data ?? null;
  const isPending = pending !== null && pending.status === 'pending';

  const sendCode = (): void =>
    void action.run(async () => {
      await api.requestStepUp('erasure');
      setSent(true);
    });

  const confirm = (e: React.FormEvent): void => {
    e.preventDefault();
    void action.run(async () => {
      await api.requestErasure(code);
      setOpen(false);
      setCode('');
      setConfirmPhrase('');
      setSent(false);
      props.pending.reload();
    });
  };

  const cancelErasure = (): void =>
    void cancelAction.run(async () => {
      await api.cancelErasure();
      props.pending.reload();
    });

  return (
    <div className="danger-panel">
      <h3>Erase workspace (permanent)</h3>
      <p>
        Permanently delete your workspace and all data. This cannot be undone after the undo window
        closes.
      </p>
      {isPending && pending !== null && (
        <div className="confirm-box" role="status">
          <p>
            Erasure scheduled. It will run after <strong>{fmtDate(pending.executeAt)}</strong>. You
            can cancel until then.
          </p>
          {cancelAction.error !== null && (
            <p className="alert" role="alert">
              {cancelAction.error}
            </p>
          )}
          <button type="button" onClick={cancelErasure} disabled={cancelAction.busy}>
            {cancelAction.busy && <span className="spinner" aria-hidden="true" />}
            Cancel scheduled erasure
          </button>
        </div>
      )}
      {!isPending && (
        <button type="button" className="danger-button" onClick={() => setOpen(true)}>
          Erase workspace…
        </button>
      )}
      {open && (
        <Modal titleId={titleId} title="Permanently erase workspace" onClose={() => setOpen(false)}>
          <p>
            This is irreversible. Type <strong>ERASE</strong> and confirm with a one-time code.
            After confirmation you’ll have a grace window to cancel.
          </p>
          {action.error !== null && (
            <p className="alert" role="alert">
              {action.error}
            </p>
          )}
          <form onSubmit={confirm}>
            <label htmlFor="erase-confirm">Type ERASE to confirm</label>
            <input
              id="erase-confirm"
              value={confirmPhrase}
              onChange={(e) => setConfirmPhrase(e.target.value)}
              autoComplete="off"
              required
            />
            {!sent ? (
              <div className="actions">
                <button
                  type="button"
                  onClick={sendCode}
                  disabled={action.busy || confirmPhrase !== 'ERASE'}
                >
                  {action.busy && <span className="spinner" aria-hidden="true" />}
                  Email me a code
                </button>
                <button type="button" className="secondary" onClick={() => setOpen(false)}>
                  Keep my workspace
                </button>
              </div>
            ) : (
              <>
                <p role="status">If an email is on file, a code was sent.</p>
                <label htmlFor="erase-code">Confirmation code</label>
                <input
                  id="erase-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                />
                <div className="actions">
                  <button
                    type="submit"
                    className="danger-button"
                    disabled={action.busy || confirmPhrase !== 'ERASE' || code === ''}
                  >
                    {action.busy && <span className="spinner" aria-hidden="true" />}
                    Schedule erasure
                  </button>
                  <button type="button" className="secondary" onClick={() => setOpen(false)}>
                    Keep my workspace
                  </button>
                </div>
              </>
            )}
          </form>
        </Modal>
      )}
    </div>
  );
}
