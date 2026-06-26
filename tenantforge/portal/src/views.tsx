import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  api,
  ApiError,
  type CreditBalance,
  type EvidenceManifestEntry,
  type Invoice,
  type PendingErasure,
  type PlanPreview,
  type PublicJwk,
  type SignedEvidenceBundle,
  type TenantEvent,
  type TenantSummary,
  type Usage,
} from './api.js';
import type { Stripe, StripeElements } from './loaders.js';
import {
  Card,
  DataTable,
  FormField,
  InfoTip,
  Pill,
  SettingsRow,
  StatGrid,
  StatTile,
  type Column,
} from '../../shared/ui/index.js';

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

/** Trigger a browser download of `text` as a named file (CSP-safe: a Blob object URL, revoked after). */
function downloadText(filename: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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

/** A read-only event table (charges / refunds) rendered via the shared CF DataTable. */
function EventsTable(props: {
  caption: string;
  events: TenantEvent[];
  empty: string;
}): React.ReactElement {
  const columns: Column<TenantEvent>[] = [
    { key: 'when', header: 'When', cell: (e) => fmtDate(e.at) },
    {
      key: 'amount',
      header: 'Amount',
      cell: (e) => {
        const ctx = e.context ?? {};
        return typeof ctx['amountMinor'] === 'number' ? usdMinor(ctx['amountMinor']) : '—';
      },
    },
    {
      key: 'status',
      header: 'Status',
      cell: (e) => {
        const ctx = e.context ?? {};
        return typeof ctx['status'] === 'string' ? ctx['status'] : e.outcome;
      },
    },
  ];
  return (
    <DataTable
      caption={props.caption}
      columns={columns}
      rows={props.events}
      rowKey={(e, i) => `${e.at}-${i}`}
      empty={props.empty}
    />
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

/** Map a workspace status to a status-pill tone (text still carries the meaning — not color-only). */
function statusTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'active') return 'success';
  if (status === 'offboarding' || status === 'suspended') return 'warning';
  if (status === 'deleted') return 'danger';
  return 'neutral';
}

/** Overview: the account summary as overview stat tiles + current-period usage in a card. */
export function OverviewView(): React.ReactElement {
  const me = useLoad<TenantSummary>(() => api.me());
  const usage = useLoad<Usage | null>(
    () => api.usage(),
    // Usage may be unavailable (no metering) — treat a 404 as "no usage" rather than an error.
    () => null,
  );
  return (
    <>
      <Card title="Account">
        <Async state={me}>
          {(s) => (
            <StatGrid>
              <StatTile label="Workspace" value={s.slug} />
              <StatTile
                label="Status"
                value={<Pill tone={statusTone(s.status)}>{s.status}</Pill>}
                hint={
                  <InfoTip label="What the workspace status means">
                    <strong>active</strong>: running normally. <strong>suspended</strong>: paused
                    (e.g. billing) — read-only. <strong>offboarding</strong>: cancelled and within
                    the reversible grace window. <strong>deleted</strong>: erased.
                  </InfoTip>
                }
              />
              <StatTile label="Region" value={s.region} />
              <StatTile label="Member since" value={fmtDate(s.createdAt)} />
              {s.planPriceUsd !== undefined && (
                <StatTile label="Plan" value={`$${s.planPriceUsd.toFixed(2)}`} hint="per period" />
              )}
            </StatGrid>
          )}
        </Async>
      </Card>
      <Card title="Usage this period">
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
      </Card>
    </>
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
    <>
      <Card title="Credit balance">
        <Async state={credit}>
          {(c) => (
            <p>
              <strong>{usdMinor(c.balanceMinor)}</strong> {c.currency.toUpperCase()}
            </p>
          )}
        </Async>
      </Card>

      <Card title="Invoices">
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
      </Card>

      <Card title="Recent charges">
        <Async state={charges}>
          {(e) => <EventsTable caption="Charges" events={e} empty="No charges yet." />}
        </Async>
      </Card>
      <Card title="Recent refunds">
        <Async state={refunds}>
          {(e) => <EventsTable caption="Refunds" events={e} empty="No refunds yet." />}
        </Async>
      </Card>
      <Card title="Recent receipts">
        <Async state={receipts}>
          {(events) => {
            const columns: Column<TenantEvent>[] = [
              { key: 'when', header: 'When', cell: (e) => fmtDate(e.at) },
              {
                key: 'kind',
                header: 'Kind',
                cell: (e) => {
                  const ctx = e.context ?? {};
                  return typeof ctx['kind'] === 'string' ? ctx['kind'] : '—';
                },
              },
              {
                key: 'reference',
                header: 'Reference',
                cell: (e) => {
                  const ctx = e.context ?? {};
                  return typeof ctx['reference'] === 'string' ? ctx['reference'] : '—';
                },
              },
            ];
            return (
              <DataTable
                caption="Receipts"
                columns={columns}
                rows={events}
                rowKey={(e, i) => `${e.at}-${i}`}
                empty="No receipts yet."
              />
            );
          }}
        </Async>
      </Card>
    </>
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
    <Card title="Your plan">
      <Async state={plan}>
        {(p) => (
          <>
            <SettingsRow
              label="Current plan price"
              description="Your active subscription price for this billing period."
              value={
                <strong>
                  {p.current === null ? 'no plan set' : `$${p.current.toFixed(2)} / period`}
                </strong>
              }
            />
            <form onSubmit={doPreview}>
              <FormField
                id="new-price"
                label="New plan price (USD per period)"
                description={
                  p.available.length > 0
                    ? `Enter a price per billing period. Available plans: ${p.available
                        .map((a) => `$${a.priceUsd}`)
                        .join(', ')}. You'll preview any prorated charge before it applies.`
                    : "Enter a price per billing period. You'll preview any prorated charge before it applies."
                }
                info={
                  <InfoTip label="About plan price">
                    Changing your price is prorated for the rest of the current period — you preview
                    the exact charge or credit, then confirm. Nothing is charged until you confirm.
                  </InfoTip>
                }
              >
                {(field) => (
                  <input
                    {...field}
                    type="number"
                    min="0"
                    step="0.01"
                    inputMode="decimal"
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    required
                  />
                )}
              </FormField>
              <button
                type="submit"
                disabled={action.busy || target === ''}
                title="Preview the prorated charge or credit before applying the change"
              >
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
    </Card>
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
    <Card
      title="Update payment method"
      description="Your card is collected securely by Stripe and never touches our servers."
    >
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
    </Card>
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
    <>
      <p className="lede">
        These actions affect your whole workspace. Cancel is reversible during a grace window;
        erasure is permanent.
      </p>
      <DataExportPanel />
      <CancelPanel />
      <ErasurePanel pending={pending} />
    </>
  );
}

/** Data export (DSAR): request an export; show the resulting artifact location. */
function DataExportPanel(): React.ReactElement {
  const action = useAction();
  const [location, setLocation] = useState<string | null>(null);
  return (
    <Card
      title="Export your data"
      description="Download a copy of your workspace data (portability / DSAR)."
    >
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
    </Card>
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
    <Card
      title="Cancel workspace"
      description="Stop your workspace. It is retained and reversible during a grace window before deletion."
    >
      {result !== null && (
        <p className="ok-note" role="status">
          {result}
        </p>
      )}
      <button
        type="button"
        className="danger-button"
        onClick={() => setOpen(true)}
        title="Opens a confirmation step (we email a one-time code). Your workspace stays reversible during a grace window."
      >
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
    </Card>
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
    <Card
      title="Erase workspace (permanent)"
      description="Permanently delete your workspace and all data. This cannot be undone after the undo window closes."
    >
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
          <button
            type="button"
            onClick={cancelErasure}
            disabled={cancelAction.busy}
            title="Stops the scheduled erasure and keeps your workspace. Available until the undo window closes."
          >
            {cancelAction.busy && <span className="spinner" aria-hidden="true" />}
            Cancel scheduled erasure
          </button>
        </div>
      )}
      {!isPending && (
        <button
          type="button"
          className="danger-button"
          onClick={() => setOpen(true)}
          title="Permanently deletes your workspace and all data. Requires typing ERASE and a one-time code; a short undo window follows before it runs."
        >
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
    </Card>
  );
}

// --- Compliance evidence ---------------------------------------------------------------------------

/**
 * "Download my compliance evidence" (ADR-0011 Phase 3d / threat-model B8e): the self-serve,
 * **self-scoped** evidence surface. Lists **my** persisted, signed evidence-bundle manifests (facts
 * only — never the JWS body), lets me **self-generate** my own current bundle, **download** a specific
 * own signed bundle's JWS for offline verification, and load the **public verification key**. Every
 * fetch is server-scoped to my session tenant (the tenant id is never sent by the client — BOLA
 * defence), so I only ever see my own evidence. Mirrors the operator dashboard `EvidencePanel`'s
 * artifact handling: the signed JWS is a **labelled read-only/download artifact**, never rendered as
 * trusted HTML; the public key carries no private material. WCAG 2.2 AA: semantic table, labelled
 * controls, `aria-live` async status (not color), CSP-safe Blob downloads.
 */
export function EvidenceView(): React.ReactElement {
  const list = useLoad<EvidenceManifestEntry[]>(
    () => api.evidenceList(),
    // No evidence store wired ⇒ empty rather than an error (fail soft, like the other reads).
    () => [],
  );
  const [selected, setSelected] = useState<SignedEvidenceBundle | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [publicKey, setPublicKey] = useState<PublicJwk | null>(null);
  const [keyStatus, setKeyStatus] = useState<string | null>(null);
  const generate = useAction();
  const view = useAction();

  const onGenerate = (): Promise<void> =>
    generate.run(async () => {
      await api.evidenceGenerate();
      list.reload();
    });

  const onView = (bundleId: string): Promise<void> =>
    view.run(async () => {
      setSelected(null);
      setSelectedId(bundleId);
      setSelected(await api.evidenceGet(bundleId));
    });

  const onLoadKey = async (): Promise<void> => {
    setKeyStatus('Loading the public key…');
    try {
      const jwk = await api.evidencePublicKey();
      setPublicKey(jwk);
      setKeyStatus(
        jwk === null
          ? 'No evidence signer is configured — verification keys are unavailable.'
          : 'Public key loaded. It verifies a bundle offline — it contains no private material.',
      );
    } catch (e) {
      setPublicKey(null);
      setKeyStatus(
        e instanceof ApiError && e.status === 404
          ? 'No evidence signer is configured — verification keys are unavailable.'
          : e instanceof Error
            ? e.message
            : 'Could not load the public key',
      );
    }
  };

  return (
    <Card
      title="My compliance evidence"
      description={
        <>
          Signed, independently verifiable evidence bundles for your workspace (Ed25519). Generate a
          current bundle, then download it and verify its <code>jws</code> offline with the public
          key. Each bundle contains only your own attestation facts — no secrets.
        </>
      }
    >
      {/* Generate my own current bundle (non-destructive; server-scoped to my tenant). */}
      <p>
        <button type="button" onClick={() => void onGenerate()} disabled={generate.busy}>
          {generate.busy ? 'Generating…' : 'Generate a current bundle'}
        </button>
      </p>
      {generate.error !== null && (
        <p className="alert" role="alert">
          {generate.error}
        </p>
      )}

      {/* Public verification key — public material only; loaded on demand. */}
      <p>
        <button type="button" className="secondary" onClick={() => void onLoadKey()}>
          Show public verification key
        </button>
      </p>
      <p role="status" aria-live="polite">
        {keyStatus}
      </p>
      {publicKey !== null && (
        <>
          <p>
            <label htmlFor="evidence-pubkey">Ed25519 public JWK (verify bundles offline)</label>
          </p>
          <textarea
            id="evidence-pubkey"
            className="evidence-blob"
            readOnly
            rows={4}
            value={JSON.stringify(publicKey, null, 2)}
          />
          <p>
            <button
              type="button"
              className="secondary"
              onClick={() =>
                downloadText(
                  'tenantforge-evidence-public-key.jwk.json',
                  JSON.stringify(publicKey, null, 2),
                  'application/json',
                )
              }
            >
              Download public key
            </button>
          </p>
        </>
      )}

      <Async state={list}>
        {(manifests) => {
          const columns: Column<EvidenceManifestEntry>[] = [
            {
              key: 'bundle',
              header: 'Bundle',
              isRowHeader: true,
              cell: (m) => <code>{m.bundleId.slice(0, 12)}…</code>,
            },
            { key: 'generated', header: 'Generated', cell: (m) => fmtDate(m.generatedAt) },
            { key: 'stored', header: 'Stored', cell: (m) => fmtDate(m.storedAt) },
            {
              key: 'retention',
              header: 'Retention until',
              cell: (m) =>
                m.retentionUntil === undefined ? 'indefinite' : fmtDate(m.retentionUntil),
            },
            {
              key: 'signer',
              header: 'Signer (kid)',
              cell: (m) => <code>{m.signerKid}</code>,
            },
            {
              key: 'action',
              header: 'Action',
              cell: (m) => (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void onView(m.bundleId)}
                  disabled={view.busy && selectedId === m.bundleId}
                  aria-label={`View bundle ${m.bundleId}`}
                >
                  {view.busy && selectedId === m.bundleId ? 'Loading…' : 'View'}
                </button>
              ),
            },
          ];
          return (
            <DataTable
              caption={`My evidence bundles (${manifests.length}) — facts only, no bundle body`}
              columns={columns}
              rows={manifests}
              rowKey={(m) => m.bundleId}
              empty={
                <>
                  No evidence bundles yet. Use <strong>Generate a current bundle</strong> above to
                  create one.
                </>
              }
            />
          );
        }}
      </Async>

      {/* Selected-bundle detail — async region announced to assistive tech (not color-only). */}
      <div role="region" aria-live="polite" aria-label="Selected evidence bundle">
        {view.error !== null && (
          <p className="alert" role="alert">
            {view.error}
          </p>
        )}
        {selected !== null && selectedId !== null && (
          <div className="evidence-detail">
            <h3>Bundle</h3>
            <p>
              Generated {fmtDate(selected.bundle.generatedAt)} · inventory{' '}
              {selected.bundle.artifacts.inventory.total} ·{' '}
              {selected.bundle.artifacts.erasureCertificates.length} embedded erasure certificate(s)
              · {selected.bundle.artifacts.auditExcerpt.length} audit event(s) in the excerpt.
            </p>
            <p>
              <label htmlFor="evidence-jws">
                Signed bundle (compact JWS — verify offline, do not edit)
              </label>
            </p>
            <textarea
              id="evidence-jws"
              className="evidence-blob"
              readOnly
              rows={4}
              value={selected.jws}
            />
            <p>
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  downloadText(
                    `evidence-bundle-${selectedId}.jws`,
                    selected.jws,
                    'application/jose',
                  )
                }
              >
                Download signed bundle
              </button>
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}
