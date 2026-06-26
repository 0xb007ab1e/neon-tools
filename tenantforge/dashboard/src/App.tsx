import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchCompliance,
  fetchEvidenceBundles,
  fetchEvidenceBundle,
  fetchEvidencePublicKey,
  type EvidenceManifestEntry,
  type SignedEvidenceBundle,
  type PublicJwk,
  fetchOperatorDigest,
  type OperatorDigest,
  type DigestSeverity,
  fetchWebhookSubscriptions,
  type WebhookSubscriptionEntry,
  fetchCost,
  fetchDrift,
  fetchInvoices,
  fetchReconcilePlan,
  fetchReconcileHistory,
  fetchReconcileCapabilities,
  runReconcile,
  fetchCharges,
  fetchPaymentEvents,
  fetchDunning,
  fetchBillingRuns,
  fetchRefunds,
  fetchNotifications,
  fetchPlanChanges,
  fetchCreditGrants,
  fetchUsageAlerts,
  fetchPlans,
  fetchInvoicesSent,
  fetchAudit,
  fetchAuditAnomalies,
  fetchSignupTokens,
  fetchCostAnomalies,
  fetchExports,
  fetchRetention,
  fetchSession,
  login,
  logout,
  type ComplianceReport,
  type CostReport,
  type DriftReport,
  type FleetInvoiceReport,
  type ReconcileCapabilities,
  type ReconcilePlan,
  type ReconcileHistoryEntry,
  type ChargeHistoryEntry,
  type PaymentEventEntry,
  type DunningHistoryEntry,
  type BillingRunEntry,
  type RefundEntry,
  type NotificationEntry,
  type PlanChangeEntry,
  type CreditGrantEntry,
  type UsageAlertEntry,
  type PlanEntry,
  type InvoiceSentEntry,
  type AuditEventEntry,
  type AuditAnomalyEntry,
  type SignupTokenEntry,
  type CostAnomalyEntry,
  type ExportEntry,
  type RetentionReport,
  type Session,
} from './api';
import { AppShell, StatGrid, StatTile, type NavGroup } from '../../shared/ui/index.js';

/**
 * Resolve + apply the light/dark theme. Defaults to the OS `prefers-color-scheme`, with an in-app
 * toggle that persists the explicit choice (localStorage). Applied via `data-theme` on the root so
 * the token CSS can switch; `prefers-reduced-motion` is honored in CSS. Accessibility-first.
 */
function useTheme(): { theme: 'light' | 'dark'; toggle: () => void } {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      const stored = localStorage.getItem('tf-theme');
      if (stored === 'light' || stored === 'dark') return stored;
    } catch {
      /* localStorage unavailable — fall back to system */
    }
    if (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
    ) {
      return 'dark';
    }
    return 'light';
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const toggle = useCallback(() => {
    setTheme((t) => {
      const next = t === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem('tf-theme', next);
      } catch {
        /* ignore persistence failure */
      }
      return next;
    });
  }, []);
  return { theme, toggle };
}

/** An accessible light/dark theme toggle (labelled; shows the current theme + what it switches to). */
function ThemeToggle(props: { theme: 'light' | 'dark'; onToggle: () => void }): React.JSX.Element {
  const next = props.theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={props.onToggle}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
    >
      <span aria-hidden="true">{props.theme === 'dark' ? '🌙' : '☀️'}</span>
      <span className="theme-toggle-label">{props.theme === 'dark' ? 'Dark' : 'Light'}</span>
    </button>
  );
}

/** Root dashboard app: auth gate → panels. */
export function App(): React.JSX.Element {
  const { theme, toggle } = useTheme();
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchSession()
      .then(setSession)
      .catch(() => setSession(null));
  }, []);

  if (session === undefined) {
    return (
      <main className="app app-center">
        <p role="status">Loading…</p>
      </main>
    );
  }
  if (session === null) {
    return (
      <LoginView
        error={error}
        theme={theme}
        onToggleTheme={toggle}
        onSubmit={async (token) => {
          setError(null);
          try {
            setSession(await login(token));
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Login failed');
          }
        }}
      />
    );
  }
  return (
    <DashboardView
      session={session}
      theme={theme}
      onToggleTheme={toggle}
      onLogout={async () => {
        await logout();
        setSession(null);
      }}
    />
  );
}

/** Token login form. */
function LoginView(props: {
  error: string | null;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onSubmit: (token: string) => void | Promise<void>;
}): React.JSX.Element {
  const [token, setToken] = useState('');
  return (
    <main className="app app-center">
      <div className="login-card card">
        <div className="login-head">
          <span className="brand-mark" aria-hidden="true">
            TF
          </span>
          <ThemeToggle theme={props.theme} onToggle={props.onToggleTheme} />
        </div>
        <h1 className="login-title">TenantForge</h1>
        <p className="login-sub">Control plane for database-per-tenant SaaS on Neon.</p>
        <form
          className="login"
          onSubmit={(e) => {
            e.preventDefault();
            void props.onSubmit(token);
          }}
        >
          <h2>Sign in</h2>
          <label htmlFor="token">Operator token</label>
          <input
            id="token"
            name="token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
          />
          {props.error !== null && (
            <p role="alert" className="error">
              {props.error}
            </p>
          )}
          <button type="submit" className="btn-primary">
            Sign in
          </button>
        </form>
      </div>
    </main>
  );
}

/**
 * The dashboard's top-level sections (grouped panels), each deep-linkable via `#/<id>`. Each carries
 * a decorative sidebar icon (aria-hidden; the label is the accessible name) and a sidebar group
 * heading so the left nav reads Cloudflare-style without changing the section set the routes/tests use.
 */
const SECTIONS = [
  { id: 'health', label: 'Health', icon: '\u{1FAC0}', group: 'Overview' }, // anatomical heart
  { id: 'fleet', label: 'Fleet', icon: '\u{1F6F0}', group: 'Fleet & compliance' }, // satellite
  { id: 'billing', label: 'Billing', icon: '\u{1F4B3}', group: 'Revenue' }, // card
  { id: 'audit', label: 'Audit', icon: '\u{1F4DC}', group: 'Fleet & compliance' }, // scroll
] as const;
type SectionId = (typeof SECTIONS)[number]['id'];
const SECTION_IDS: readonly string[] = SECTIONS.map((s) => s.id);

/** Hash-based section routing (deep-linkable, dependency-free). Unknown hashes are ignored. */
function useHashRoute(): [SectionId, (id: SectionId) => void] {
  const read = (): SectionId => {
    const raw = window.location.hash.replace(/^#\/?/, '');
    return SECTION_IDS.includes(raw) ? (raw as SectionId) : 'health';
  };
  const [active, setActive] = useState<SectionId>(read);
  useEffect(() => {
    const onHash = (): void => {
      const raw = window.location.hash.replace(/^#\/?/, '');
      if (SECTION_IDS.includes(raw)) setActive(raw as SectionId); // ignore e.g. the #main skip-link
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const navigate = useCallback((id: SectionId) => {
    setActive(id);
    try {
      window.location.hash = `#/${id}`;
    } catch {
      /* ignore */
    }
  }, []);
  return [active, navigate];
}

/** Build the Cloudflare-style sidebar groups from the section list (group heading → its sections). */
function buildNavGroups(): NavGroup[] {
  const order: readonly string[] = ['Overview', 'Fleet & compliance', 'Revenue'];
  const byGroup = new Map<string, NavGroup['items'][number][]>();
  for (const s of SECTIONS) {
    const items = byGroup.get(s.group) ?? [];
    items.push({ id: s.id, label: s.label, icon: s.icon });
    byGroup.set(s.group, items);
  }
  return order
    .filter((g) => byGroup.has(g))
    .map((g) => ({ heading: g, items: byGroup.get(g) ?? [] }));
}

/**
 * Signed-in shell: the shared Cloudflare-style {@link AppShell} (persistent left sidebar + top
 * account bar + content; responsive left off-canvas drawer on narrow viewports), with the operator
 * identity/role + theme toggle + sign-out in the top bar. Focus moves to `<main>` on each section
 * change. The section set + routing are unchanged — only the layout/IA moved to the shared shell.
 */
function DashboardView(props: {
  session: Session;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onLogout: () => void | Promise<void>;
}): React.JSX.Element {
  const [active, navigate] = useHashRoute();
  const mainRef = useRef<HTMLElement>(null);
  const firstRender = useRef(true);
  // On a section change, move focus to <main> so keyboard / screen-reader users land in the new content.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    mainRef.current?.focus();
  }, [active]);
  const activeLabel = SECTIONS.find((s) => s.id === active)?.label ?? '';

  const brand = (
    <>
      <span className="cf-brand-mark" aria-hidden="true">
        TF
      </span>
      <span className="cf-brand-name">TenantForge</span>
    </>
  );

  const topbarContext = (
    <span className="who">
      Signed in as <strong>{props.session.id}</strong>{' '}
      <span className="role-chip">{props.session.role}</span>
    </span>
  );

  const topbarActions = (
    <>
      <ThemeToggle theme={props.theme} onToggle={props.onToggleTheme} />
      <button type="button" className="btn-ghost" onClick={() => void props.onLogout()}>
        Sign out
      </button>
    </>
  );

  return (
    <AppShell
      brand={brand}
      navGroups={buildNavGroups()}
      navAriaLabel="Dashboard sections"
      activeId={active}
      href={(id) => `#/${id}`}
      onSelect={(id) => navigate(id as SectionId)}
      topbarContext={topbarContext}
      topbarActions={topbarActions}
      mainLabel={`${activeLabel} section`}
      mainRef={mainRef}
      collapseStorageKey="tf-dashboard-sidebar-collapsed"
    >
      <div className="panels">
        {active === 'health' && (
          <>
            <OperatorDigestPanel />
            <WebhookSubscriptionsPanel />
          </>
        )}
        {active === 'fleet' && (
          <>
            <CompliancePanel />
            <EvidencePanel />
            <DriftPanel />
            <ReconcilePanel />
            <RetentionPanel />
            <ExportsPanel />
          </>
        )}
        {active === 'billing' && (
          <>
            <CostPanel />
            <PlansPanel />
            <SignupTokensPanel />
            <InvoicesPanel />
            <BillingPanel />
          </>
        )}
        {active === 'audit' && <AuditPanel />}
      </div>
    </AppShell>
  );
}

/** Load panel data once; expose loading/error/data. */
function usePanelData<T>(load: () => Promise<T>): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    load()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'));
    // load is stable per panel; intentional one-shot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { data, error };
}

/** A card-styled panel with heading + loading/error states. Body scrolls horizontally on overflow. */
function Panel(props: {
  id: string;
  title: string;
  error: string | null;
  loading: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="panel card" aria-labelledby={props.id}>
      <h2 id={props.id} className="panel-title">
        {props.title}
      </h2>
      {props.error !== null && (
        <p role="alert" className="error">
          {props.error}
        </p>
      )}
      {props.loading && props.error === null && (
        <p role="status" className="loading">
          Loading…
        </p>
      )}
      <div className="panel-body">{props.children}</div>
    </section>
  );
}

function statusText(ok: boolean): React.JSX.Element {
  return (
    <span className={ok ? 'status status-ok' : 'status status-bad'}>
      {ok ? '✓ Compliant' : '✗ Violations'}
    </span>
  );
}

/** Severity badge — urgency shown by the text label + a class, never color alone (WCAG 1.4.1). */
function severityBadge(severity: DigestSeverity): React.JSX.Element {
  return <span className={`status status-sev status-sev-${severity}`}>{severity}</span>;
}

/** Operator alert digest — the at-a-glance control-plane health roll-up (default landing panel). */
function OperatorDigestPanel(): React.JSX.Element {
  const { data, error } = usePanelData<OperatorDigest>(fetchOperatorDigest);
  return (
    <Panel id="operator-digest-h" title="Operator digest" error={error} loading={data === null}>
      {data !== null && (
        <div>
          {/* At-a-glance roll-up as Cloudflare-style stat tiles (the detail table + headline follow). */}
          <StatGrid>
            <StatTile label="Overall severity" value={severityBadge(data.severity)} />
            <StatTile
              label="Open issues"
              value={data.totalIssues}
              hint={data.totalIssues === 1 ? 'issue' : 'issues'}
            />
            <StatTile label="Detectors" value={data.categories.length} hint="evaluated" />
          </StatGrid>
          <p className="digest-headline">{data.headline}</p>
          <p>
            {data.totalIssues} issue{data.totalIssues === 1 ? '' : 's'} · generated{' '}
            {new Date(data.generatedAt).toLocaleString()}
          </p>
          <table>
            <caption>Detector breakdown</caption>
            <thead>
              <tr>
                <th scope="col">Detector</th>
                <th scope="col">Severity</th>
                <th scope="col">Count</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {data.categories.map((c) => (
                <tr key={c.category}>
                  <th scope="row">{c.category}</th>
                  <td>{severityBadge(c.severity)}</td>
                  <td>{c.count}</td>
                  <td>{c.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/** Webhook subscriptions — read-only list (the signing secret is never exposed to the browser). */
function WebhookSubscriptionsPanel(): React.JSX.Element {
  const { data, error } = usePanelData<WebhookSubscriptionEntry[]>(fetchWebhookSubscriptions);
  return (
    <Panel id="webhooks-h" title="Webhook subscriptions" error={error} loading={data === null}>
      {data !== null && (
        <div>
          <p>
            {data.length} subscription(s). Create/delete runs via the CLI (`webhook-add` /
            `webhook-rm`) or the HTTP API; the signing secret is shown only once at creation.
          </p>
          {data.length > 0 && (
            <table>
              <caption>Active webhook subscriptions</caption>
              <thead>
                <tr>
                  <th scope="col">URL</th>
                  <th scope="col">Events</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.map((s) => (
                  <tr key={s.id}>
                    <th scope="row">{s.url}</th>
                    <td>{s.eventTypes.length > 0 ? s.eventTypes.join(', ') : 'all'}</td>
                    <td>{s.active ? 'active' : 'inactive'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Panel>
  );
}

function CompliancePanel(): React.JSX.Element {
  const { data, error } = usePanelData<{ report: ComplianceReport; digest: string }>(
    fetchCompliance,
  );
  return (
    <Panel id="compliance-h" title="Compliance" error={error} loading={data === null}>
      {data !== null && (
        <div>
          <p>
            {data.report.inventory.total} tenants · digest <code>{data.digest.slice(0, 12)}…</code>
          </p>
          <p>Isolation {statusText(data.report.isolation.compliant)}</p>
          <p>Residency {statusText(data.report.residency.compliant)}</p>
          {data.report.residency.violations.length > 0 && (
            <table>
              <caption>Residency violations</caption>
              <thead>
                <tr>
                  <th scope="col">Tenant</th>
                  <th scope="col">Region</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {data.report.residency.violations.map((v) => (
                  <tr key={v.tenantId}>
                    <td>{v.tenantId}</td>
                    <td>{v.region}</td>
                    <td>{v.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data.report.audit !== undefined && (
            <>
              <p>Erasures recorded: {data.report.audit.erasures.length}</p>
              {data.report.audit.erasures.length > 0 && (
                <table>
                  <caption>Erasure history (right-to-erasure evidence)</caption>
                  <thead>
                    <tr>
                      <th scope="col">When</th>
                      <th scope="col">Tenant</th>
                      <th scope="col">Operator</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.report.audit.erasures.map((e) => (
                      <tr key={`${e.at}-${e.tenantId ?? ''}`}>
                        <td>{e.at}</td>
                        <td>{e.tenantId ?? '—'}</td>
                        <td>{e.actor !== undefined ? `${e.actor.id} (${e.actor.role})` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      )}
    </Panel>
  );
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

/**
 * Signed compliance evidence (ADR-0011 Phase 3c). Lists persisted evidence-bundle **manifests**
 * (facts only — never the JWS body), lets an operator open one to view its manifest + **download the
 * signed bundle JWS** for offline verification, and exposes the **public verification key**. All data
 * is non-secret (attestation facts + the public key); no private material is ever shown or expected.
 * Mirrors the sibling {@link CompliancePanel}: same `usePanelData` hook, `Panel` shell, accessible
 * tables, and status patterns. The async detail/key fetches use an `aria-live` region (not color).
 */
function EvidencePanel(): React.JSX.Element {
  const { data, error } = usePanelData<EvidenceManifestEntry[]>(fetchEvidenceBundles);
  const [selected, setSelected] = useState<SignedEvidenceBundle | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [publicKey, setPublicKey] = useState<PublicJwk | null>(null);
  const [keyStatus, setKeyStatus] = useState<string | null>(null);

  const onView = async (bundleId: string): Promise<void> => {
    setBusyId(bundleId);
    setDetailError(null);
    setSelected(null);
    setSelectedId(bundleId);
    try {
      const bundle = await fetchEvidenceBundle(bundleId);
      if (bundle === null) {
        setDetailError('Bundle not found (it may have been pruned past its retention).');
        return;
      }
      setSelected(bundle);
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : 'Could not load the bundle');
    } finally {
      setBusyId(null);
    }
  };

  const onLoadKey = async (): Promise<void> => {
    setKeyStatus('Loading the public key…');
    try {
      const jwk = await fetchEvidencePublicKey();
      if (jwk === null) {
        setPublicKey(null);
        setKeyStatus('No evidence-bundle signer is configured on this server.');
        return;
      }
      setPublicKey(jwk);
      setKeyStatus('Public key loaded. It verifies a bundle JWS offline — no private material.');
    } catch (e) {
      setKeyStatus(e instanceof Error ? e.message : 'Could not load the public key');
    }
  };

  return (
    <Panel id="evidence-h" title="Signed evidence bundles" error={error} loading={data === null}>
      {data !== null && (
        <div>
          <p>
            {data.length} persisted bundle(s). Bundles are signed (Ed25519); download a bundle and
            verify its <code>jws</code> offline with the public key. Generating runs via the CLI
            (`evidence-bundle`) or the HTTP API, not the dashboard.
          </p>

          {/* Public verification key affordance — public material only; loaded on demand. */}
          <p>
            <button type="button" className="btn-ghost" onClick={() => void onLoadKey()}>
              Show public verification key
            </button>
          </p>
          <p role="status" aria-live="polite" className="loading">
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
                  className="btn-ghost"
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

          {data.length > 0 && (
            <table>
              <caption>Persisted evidence-bundle manifests (facts only — no bundle body)</caption>
              <thead>
                <tr>
                  <th scope="col">Bundle</th>
                  <th scope="col">Scope</th>
                  <th scope="col">Tenant</th>
                  <th scope="col">Generated</th>
                  <th scope="col">Stored</th>
                  <th scope="col">Retention until</th>
                  <th scope="col">Signer (kid)</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {data.map((m) => (
                  <tr key={m.bundleId}>
                    <th scope="row">
                      <code>{m.bundleId.slice(0, 12)}…</code>
                    </th>
                    <td>{m.scope}</td>
                    <td>{m.tenantId ?? '—'}</td>
                    <td>{m.generatedAt}</td>
                    <td>{m.storedAt}</td>
                    <td>{m.retentionUntil ?? 'indefinite'}</td>
                    <td>
                      <code>{m.signerKid}</code>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => void onView(m.bundleId)}
                        disabled={busyId === m.bundleId}
                        aria-label={`View bundle ${m.bundleId}`}
                      >
                        {busyId === m.bundleId ? 'Loading…' : 'View'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* Selected-bundle detail — async region announced to assistive tech (not color-only). */}
          <div role="region" aria-live="polite" aria-label="Selected evidence bundle">
            {detailError !== null && (
              <p role="alert" className="error">
                {detailError}
              </p>
            )}
            {selected !== null && selectedId !== null && (
              <div className="evidence-detail">
                <h3>Bundle {selected.bundle.scope === 'tenant' ? '(tenant)' : '(fleet)'}</h3>
                <p>
                  Generated {selected.bundle.generatedAt}
                  {selected.bundle.tenantId !== undefined
                    ? ` · tenant ${selected.bundle.tenantId}`
                    : ''}{' '}
                  · inventory {selected.bundle.artifacts.inventory.total} · isolation{' '}
                  {statusText(selected.bundle.artifacts.isolation.compliant)} · residency{' '}
                  {statusText(selected.bundle.artifacts.residency.compliant)}
                </p>
                <p>
                  {selected.bundle.artifacts.erasureCertificates.length} embedded erasure
                  certificate(s) · {selected.bundle.artifacts.auditExcerpt.length} audit event(s) in
                  the excerpt.
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
                    className="btn-ghost"
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
        </div>
      )}
    </Panel>
  );
}

function DriftPanel(): React.JSX.Element {
  const { data, error } = usePanelData<DriftReport>(fetchDrift);
  return (
    <Panel id="drift-h" title="Fleet migration drift" error={error} loading={data === null}>
      {data !== null && (
        <table>
          <caption>
            Target version {data.latest ?? 'none'} ({data.totalVersions} known)
          </caption>
          <thead>
            <tr>
              <th scope="col">Total</th>
              <th scope="col">At latest</th>
              <th scope="col">Drifted</th>
              <th scope="col">With failures</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{data.summary.total}</td>
              <td>{data.summary.atLatest}</td>
              <td>{data.summary.drifted}</td>
              <td>{data.summary.withFailures}</td>
            </tr>
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function ReconcilePanel(): React.JSX.Element {
  const { data, error } = usePanelData<ReconcilePlan>(fetchReconcilePlan);
  const history = usePanelData<ReconcileHistoryEntry[]>(fetchReconcileHistory);
  const caps = usePanelData<ReconcileCapabilities>(fetchReconcileCapabilities);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const canRun = caps.data?.executable === true && caps.data?.mayExecute === true;

  const onRun = async (): Promise<void> => {
    if (
      !window.confirm('Reconcile the whole fleet now? This applies migrations to behind tenants.')
    ) {
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const r = await runReconcile();
      setResult(`Reconciled ${r.reconciled.length} tenant(s), ${r.partial.length} with failures.`);
    } catch (e) {
      setResult(e instanceof Error ? e.message : 'Reconcile failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel id="reconcile-h" title="Fleet reconcile (plan)" error={error} loading={data === null}>
      {data !== null && (
        <div>
          <p>
            {data.pendingTenants.length} tenant(s) behind target{' '}
            <strong>{data.target ?? 'none'}</strong> · {data.totalMissing} migration application(s)
            · {data.upToDate.length} up to date
          </p>
          {canRun ? (
            <p>
              <button type="button" onClick={() => void onRun()} disabled={busy}>
                {busy ? 'Reconciling…' : 'Run reconcile'}
              </button>
            </p>
          ) : (
            <p>Preview only — run `reconcile-fleet` (CLI) to apply.</p>
          )}
          {result !== null && <p role="status">{result}</p>}
          {history.data !== null && history.data.length > 0 && (
            <table>
              <caption>Recent reconcile runs (audit trail)</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Target</th>
                  <th scope="col">Reconciled</th>
                  <th scope="col">Failures</th>
                  <th scope="col">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {history.data.map((h) => (
                  <tr key={`${h.at}-${h.actor?.id ?? ''}`}>
                    <td>{h.at}</td>
                    <td>{h.context?.target ?? '—'}</td>
                    <td>{h.context?.reconciled ?? 0}</td>
                    <td>{h.context?.partial ?? 0}</td>
                    <td>{h.outcome}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data.perTenant.length > 0 && (
            <table>
              <caption>Versions each behind tenant would receive</caption>
              <thead>
                <tr>
                  <th scope="col">Tenant</th>
                  <th scope="col">Missing versions (in order)</th>
                </tr>
              </thead>
              <tbody>
                {data.perTenant.map((t) => (
                  <tr key={t.tenantId}>
                    <th scope="row">{t.tenantId}</th>
                    <td>{t.missing.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Panel>
  );
}

function BillingPanel(): React.JSX.Element {
  const { data, error } = usePanelData<ChargeHistoryEntry[]>(fetchCharges);
  const events = usePanelData<PaymentEventEntry[]>(fetchPaymentEvents);
  const dunning = usePanelData<DunningHistoryEntry[]>(fetchDunning);
  const runs = usePanelData<BillingRunEntry[]>(fetchBillingRuns);
  const refunds = usePanelData<RefundEntry[]>(fetchRefunds);
  const notifications = usePanelData<NotificationEntry[]>(fetchNotifications);
  const planChanges = usePanelData<PlanChangeEntry[]>(fetchPlanChanges);
  const creditGrants = usePanelData<CreditGrantEntry[]>(fetchCreditGrants);
  const usageAlerts = usePanelData<UsageAlertEntry[]>(fetchUsageAlerts);
  const invoicesSent = usePanelData<InvoiceSentEntry[]>(fetchInvoicesSent);
  return (
    <Panel id="billing-h" title="Billing (recent charges)" error={error} loading={data === null}>
      {data !== null && (
        <div>
          <p>
            {data.length} recent charge(s). Charging runs via the CLI (`charge` / `charge-fleet`),
            not the dashboard.
          </p>
          {data.length > 0 && (
            <table>
              <caption>Recent charges (audit trail)</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Tenant</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.map((c) => (
                  <tr key={`${c.at}-${c.tenantId ?? ''}`}>
                    <td>{c.at}</td>
                    <td>{c.tenantId ?? '—'}</td>
                    <td>
                      {c.context?.amountMinor ?? '—'} {c.context?.currency ?? ''}
                    </td>
                    <td>{c.context?.status ?? c.outcome}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {events.data !== null && events.data.length > 0 && (
            <table>
              <caption>Recent inbound PSP webhook events</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Type</th>
                  <th scope="col">Tenant</th>
                  <th scope="col">Charge</th>
                </tr>
              </thead>
              <tbody>
                {events.data.map((e) => (
                  <tr key={`${e.at}-${e.context?.chargeId ?? ''}`}>
                    <td>{e.at}</td>
                    <td>{e.context?.type ?? '—'}</td>
                    <td>{e.tenantId ?? '—'}</td>
                    <td>{e.context?.chargeId ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {runs.data !== null && runs.data.length > 0 && (
            <table>
              <caption>Recent billing runs</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Charged</th>
                  <th scope="col">Retried</th>
                  <th scope="col">Suspended</th>
                  <th scope="col">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {runs.data.map((r) => (
                  <tr key={r.at}>
                    <td>{r.at}</td>
                    <td>{r.context?.charged ?? '—'}</td>
                    <td>{r.context?.retried ?? '—'}</td>
                    <td>{r.context?.suspended ?? '—'}</td>
                    <td>{r.outcome}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {creditGrants.data !== null && creditGrants.data.length > 0 && (
            <table>
              <caption>Recent credit grants</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Tenant</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {creditGrants.data.map((g) => (
                  <tr key={`${g.at}-${g.tenantId ?? ''}`}>
                    <td>{g.at}</td>
                    <td>{g.tenantId ?? '—'}</td>
                    <td>
                      {g.context?.amountMinor ?? '—'} {g.context?.currency ?? ''}
                    </td>
                    <td>{g.context?.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {invoicesSent.data !== null && invoicesSent.data.length > 0 && (
            <table>
              <caption>Recent invoice deliveries (emailed to tenants)</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Tenant</th>
                  <th scope="col">Total (USD)</th>
                </tr>
              </thead>
              <tbody>
                {invoicesSent.data.map((e) => (
                  <tr key={`${e.at}-${e.tenantId ?? ''}`}>
                    <td>{e.at}</td>
                    <td>{e.tenantId ?? '—'}</td>
                    <td>{e.context?.totalUsd ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {usageAlerts.data !== null && usageAlerts.data.length > 0 && (
            <table>
              <caption>Recent usage alerts (approaching/over plan allowance)</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Tenant</th>
                  <th scope="col">Dimensions</th>
                </tr>
              </thead>
              <tbody>
                {usageAlerts.data.map((a) => (
                  <tr key={`${a.at}-${a.tenantId ?? ''}`}>
                    <td>{a.at}</td>
                    <td>{a.tenantId ?? '—'}</td>
                    <td>
                      {(a.context?.alerts ?? [])
                        .map((x) => `${x.metric} ${Math.round(x.usedFraction * 100)}%`)
                        .join(', ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {planChanges.data !== null && planChanges.data.length > 0 && (
            <table>
              <caption>Recent plan changes</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Tenant</th>
                  <th scope="col">From → To</th>
                  <th scope="col">Settlement</th>
                </tr>
              </thead>
              <tbody>
                {planChanges.data.map((p) => (
                  <tr key={`${p.at}-${p.tenantId ?? ''}`}>
                    <td>{p.at}</td>
                    <td>{p.tenantId ?? '—'}</td>
                    <td>
                      ${p.context?.oldPriceUsd ?? '—'} → ${p.context?.newPriceUsd ?? '—'}
                    </td>
                    <td>{p.context?.settlement ?? p.outcome}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {notifications.data !== null && notifications.data.length > 0 && (
            <table>
              <caption>Recent receipts (notifications)</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Tenant</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {notifications.data.map((n) => (
                  <tr key={`${n.at}-${n.context?.reference ?? ''}`}>
                    <td>{n.at}</td>
                    <td>{n.tenantId ?? '—'}</td>
                    <td>{n.context?.kind ?? '—'}</td>
                    <td>{n.context?.status ?? n.outcome}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {refunds.data !== null && refunds.data.length > 0 && (
            <table>
              <caption>Recent refunds</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Tenant</th>
                  <th scope="col">Charge</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {refunds.data.map((r) => (
                  <tr key={`${r.at}-${r.context?.refundId ?? ''}`}>
                    <td>{r.at}</td>
                    <td>{r.tenantId ?? '—'}</td>
                    <td>{r.context?.chargeId ?? '—'}</td>
                    <td>
                      {r.context?.amountMinor ?? '—'} {r.context?.currency ?? ''}
                    </td>
                    <td>{r.context?.status ?? r.outcome}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {dunning.data !== null && dunning.data.length > 0 && (
            <table>
              <caption>Recent dunning (failed-charge retries)</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Tenant</th>
                  <th scope="col">Action</th>
                  <th scope="col">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {dunning.data.map((d) => (
                  <tr key={`${d.at}-${d.tenantId ?? ''}`}>
                    <td>{d.at}</td>
                    <td>{d.tenantId ?? '—'}</td>
                    <td>
                      {d.context?.action ?? '—'}
                      {d.context?.attempt !== undefined ? ` #${d.context.attempt}` : ''}
                    </td>
                    <td>{d.outcome}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Panel>
  );
}

function RetentionPanel(): React.JSX.Element {
  const { data, error } = usePanelData<RetentionReport>(fetchRetention);
  return (
    <Panel
      id="retention-h"
      title="Retention (scheduled purges)"
      error={error}
      loading={data === null}
    >
      {data !== null && (
        <div>
          <p>
            {data.eligible} eligible now · {data.pending} pending · retention {data.retentionDays}d.
            Purging runs via the CLI (`purge-expired`), not the dashboard.
          </p>
          {data.tenants.length > 0 && (
            <table>
              <caption>Archived tenants and when they become purge-eligible</caption>
              <thead>
                <tr>
                  <th scope="col">Tenant</th>
                  <th scope="col">Archived</th>
                  <th scope="col">Purge-eligible</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.tenants.map((t) => (
                  <tr key={t.tenantId} className={t.eligible ? 'status-bad' : undefined}>
                    <th scope="row">{t.tenantId}</th>
                    <td>{t.archivedAt}</td>
                    <td>{t.purgeEligibleAt}</td>
                    <td>{t.eligible ? 'eligible' : 'pending'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Panel>
  );
}

function ExportsPanel(): React.JSX.Element {
  const { data, error } = usePanelData<ExportEntry[]>(fetchExports);
  return (
    <Panel
      id="exports-h"
      title="Data exports (portability / DSAR)"
      error={error}
      loading={data === null}
    >
      {data !== null && (
        <div>
          <p>
            {data.length} recent export(s). Exporting reads tenant data and runs via the CLI
            (`export-tenant`), not the dashboard.
          </p>
          {data.length > 0 && (
            <table>
              <caption>Recent data exports</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Tenant</th>
                  <th scope="col">Location</th>
                  <th scope="col">Bytes</th>
                </tr>
              </thead>
              <tbody>
                {data.map((e, i) => (
                  <tr key={`${e.at}-${e.tenantId ?? ''}-${i}`}>
                    <td>{e.at}</td>
                    <td>{e.tenantId ?? '—'}</td>
                    <td>{e.context?.location ?? '—'}</td>
                    <td>{e.context?.bytes ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Panel>
  );
}

function AuditPanel(): React.JSX.Element {
  const { data, error } = usePanelData<AuditEventEntry[]>(fetchAudit);
  const anomalies = usePanelData<AuditAnomalyEntry[]>(fetchAuditAnomalies);
  return (
    <Panel id="audit-h" title="Audit log (recent)" error={error} loading={data === null}>
      {data !== null && (
        <div>
          <p>
            {data.length} recent control-plane event(s) — who-did-what-when. Filter the full trail
            via the CLI (`audit`) or `GET /v1/audit`.
          </p>
          {anomalies.data !== null && anomalies.data.length > 0 && (
            <table>
              <caption>Detected anomalies (error spikes / per-actor / per-tenant clusters)</caption>
              <thead>
                <tr>
                  <th scope="col">Kind</th>
                  <th scope="col">Subject</th>
                  <th scope="col">Errors</th>
                  <th scope="col">Events</th>
                </tr>
              </thead>
              <tbody>
                {anomalies.data.map((a, i) => (
                  <tr key={`${a.kind}-${a.subject ?? ''}-${i}`}>
                    <td>{a.kind}</td>
                    <td>{a.subject ?? '—'}</td>
                    <td>{a.count}</td>
                    <td>{a.events.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data.length > 0 && (
            <table>
              <caption>Recent audit events (newest first)</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Event</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Tenant</th>
                  <th scope="col">Actor</th>
                </tr>
              </thead>
              <tbody>
                {data.map((e, i) => (
                  <tr key={`${e.at}-${e.event}-${i}`}>
                    <td>{e.at}</td>
                    <td>{e.event}</td>
                    <td>{e.outcome}</td>
                    <td>{e.tenantId ?? '—'}</td>
                    <td>{e.actor !== undefined ? `${e.actor.id} (${e.actor.role})` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Panel>
  );
}

function SignupTokensPanel(): React.JSX.Element {
  const { data, error } = usePanelData<SignupTokenEntry[]>(fetchSignupTokens);
  return (
    <Panel id="signup-h" title="Signup tokens" error={error} loading={data === null}>
      {data !== null && (
        <div>
          <p>
            {data.length} token(s). Issuing/redeeming runs via the CLI (`signup-issue` /
            `signup-redeem`); the raw token is shown only once and never stored.
          </p>
          {data.length > 0 && (
            <table>
              <caption>Recent signup tokens (status only)</caption>
              <thead>
                <tr>
                  <th scope="col">Slug</th>
                  <th scope="col">Status</th>
                  <th scope="col">Expires</th>
                  <th scope="col">Tenant</th>
                </tr>
              </thead>
              <tbody>
                {data.map((t, i) => (
                  <tr key={`${t.slug}-${t.createdAt}-${i}`}>
                    <th scope="row">{t.slug}</th>
                    <td>{t.status}</td>
                    <td>{t.expiresAt}</td>
                    <td>{t.redeemedTenantId ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Panel>
  );
}

function PlansPanel(): React.JSX.Element {
  const { data, error } = usePanelData<PlanEntry[]>(fetchPlans);
  return (
    <Panel id="plans-h" title="Plan catalog" error={error} loading={data === null}>
      {data !== null && (
        <div>
          <p>
            {data.length} plan(s). Assigning a plan to a tenant runs via the CLI (`assign-plan`),
            not the dashboard.
          </p>
          {data.length > 0 && (
            <table>
              <caption>Operator plans (price + included allowances)</caption>
              <thead>
                <tr>
                  <th scope="col">Plan</th>
                  <th scope="col">Price (USD)</th>
                  <th scope="col">Included</th>
                </tr>
              </thead>
              <tbody>
                {data.map((p) => (
                  <tr key={p.id}>
                    <th scope="row">{p.name ?? p.id}</th>
                    <td>{p.priceUsd ?? 0}</td>
                    <td>
                      {p.includedUsage === undefined || Object.keys(p.includedUsage).length === 0
                        ? '—'
                        : Object.entries(p.includedUsage)
                            .map(([k, v]) => `${k}=${v}`)
                            .join(', ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Panel>
  );
}

function InvoicesPanel(): React.JSX.Element {
  const { data, error } = usePanelData<FleetInvoiceReport>(fetchInvoices);
  return (
    <Panel id="invoices-h" title="Invoices (this month)" error={error} loading={data === null}>
      {data !== null && (
        <div>
          <p>
            {data.invoices.length} invoice(s) generated
            {data.unmetered.length > 0 ? ` · ${data.unmetered.length} unmetered` : ''} — documents,
            not charges.
          </p>
          {data.invoices.length > 0 && (
            <table>
              <caption>
                Per-tenant invoice totals (with any included-allowance overage lines)
              </caption>
              <thead>
                <tr>
                  <th scope="col">Tenant</th>
                  <th scope="col">Total</th>
                  <th scope="col">Overage lines</th>
                </tr>
              </thead>
              <tbody>
                {data.invoices.map((inv) => {
                  const overage = inv.lineItems.filter((li) => li.description.includes('(overage'));
                  return (
                    <tr key={inv.tenantId}>
                      <th scope="row">{inv.tenantId}</th>
                      <td>
                        {inv.currency} {inv.totalUsd}
                      </td>
                      <td>
                        {overage.length === 0
                          ? '—'
                          : overage
                              .map((li) => `${li.description}: ${li.quantity} × → $${li.amountUsd}`)
                              .join('; ')}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Panel>
  );
}

function CostPanel(): React.JSX.Element {
  const { data, error } = usePanelData<CostReport>(fetchCost);
  const anomalies = usePanelData<CostAnomalyEntry[]>(fetchCostAnomalies);
  return (
    <Panel id="cost-h" title="Cost & margin" error={error} loading={data === null}>
      {data !== null && (
        <div>
          <p>
            {data.totals.tenants} tenants · cost ${data.totals.costUsd} · price $
            {data.totals.priceUsd} · margin ${data.totals.marginUsd} · {data.totals.unprofitable}{' '}
            unprofitable · {data.totals.unpriced} unpriced
          </p>
          {anomalies.data !== null && anomalies.data.length > 0 && (
            <table>
              <caption>Cost anomalies (needs attention)</caption>
              <thead>
                <tr>
                  <th scope="col">Kind</th>
                  <th scope="col">Tenant</th>
                  <th scope="col">Cost</th>
                  <th scope="col">Margin</th>
                </tr>
              </thead>
              <tbody>
                {anomalies.data.map((a) => (
                  <tr key={`${a.kind}-${a.tenantId}`} className="status-bad">
                    <td>{a.kind}</td>
                    <th scope="row">{a.tenantId}</th>
                    <td>${a.costUsd}</td>
                    <td>{a.marginUsd === null ? '—' : `$${a.marginUsd}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <table>
            <caption>Per-tenant cost vs. price (USD)</caption>
            <thead>
              <tr>
                <th scope="col">Tenant</th>
                <th scope="col">Cost</th>
                <th scope="col">Price</th>
                <th scope="col">Margin</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.tenantId} className={r.unprofitable ? 'status-bad' : undefined}>
                  <th scope="row">{r.tenantId}</th>
                  <td>${r.costUsd}</td>
                  <td>{r.priceUsd === null ? '—' : `$${r.priceUsd}`}</td>
                  <td>{r.marginUsd === null ? '—' : `$${r.marginUsd}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
