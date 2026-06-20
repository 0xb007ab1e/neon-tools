import { useEffect, useState } from 'react';
import {
  fetchCompliance,
  fetchCost,
  fetchDrift,
  fetchSession,
  login,
  logout,
  type ComplianceReport,
  type CostReport,
  type DriftReport,
  type Session,
} from './api';

/** Root dashboard app: auth gate → panels. */
export function App(): React.JSX.Element {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchSession()
      .then(setSession)
      .catch(() => setSession(null));
  }, []);

  if (session === undefined) {
    return (
      <main className="app">
        <p role="status">Loading…</p>
      </main>
    );
  }
  if (session === null) {
    return (
      <LoginView
        error={error}
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
  onSubmit: (token: string) => void | Promise<void>;
}): React.JSX.Element {
  const [token, setToken] = useState('');
  return (
    <main className="app">
      <h1>TenantForge</h1>
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
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}

/** Signed-in shell: header + the panels. */
function DashboardView(props: {
  session: Session;
  onLogout: () => void | Promise<void>;
}): React.JSX.Element {
  return (
    <div className="app">
      <header className="topbar">
        <h1>TenantForge</h1>
        <p>
          Signed in as <strong>{props.session.id}</strong> ({props.session.role}){' '}
          <button type="button" onClick={() => void props.onLogout()}>
            Sign out
          </button>
        </p>
      </header>
      <main>
        <CompliancePanel />
        <DriftPanel />
        <CostPanel />
      </main>
    </div>
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

/** A section wrapper with heading + loading/error states. */
function Panel(props: {
  id: string;
  title: string;
  error: string | null;
  loading: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section aria-labelledby={props.id}>
      <h2 id={props.id}>{props.title}</h2>
      {props.error !== null && (
        <p role="alert" className="error">
          {props.error}
        </p>
      )}
      {props.loading && props.error === null && <p role="status">Loading…</p>}
      {props.children}
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

function CostPanel(): React.JSX.Element {
  const { data, error } = usePanelData<CostReport>(fetchCost);
  return (
    <Panel id="cost-h" title="Cost & margin" error={error} loading={data === null}>
      {data !== null && (
        <div>
          <p>
            {data.totals.tenants} tenants · cost ${data.totals.costUsd} · price $
            {data.totals.priceUsd} · margin ${data.totals.marginUsd} · {data.totals.unprofitable}{' '}
            unprofitable · {data.totals.unpriced} unpriced
          </p>
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
