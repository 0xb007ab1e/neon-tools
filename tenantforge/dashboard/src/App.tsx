import { useEffect, useState } from 'react';
import {
  fetchSession,
  fetchCompliance,
  login,
  logout,
  type ComplianceReport,
  type Session,
} from './api';

/** Root dashboard app: auth gate → compliance panel. */
export function App(): React.JSX.Element {
  // undefined = checking session; null = not authenticated; Session = signed in.
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

/** Signed-in shell: header + the compliance panel. */
function DashboardView(props: {
  session: Session;
  onLogout: () => void | Promise<void>;
}): React.JSX.Element {
  const [data, setData] = useState<{ report: ComplianceReport; digest: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchCompliance()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'));
  }, []);

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
        <h2>Compliance report</h2>
        {error !== null && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {data === null && error === null && <p role="status">Loading report…</p>}
        {data !== null && <CompliancePanel report={data.report} digest={data.digest} />}
      </main>
    </div>
  );
}

/** Renders the compliance attestation as accessible sections + tables. */
function CompliancePanel(props: { report: ComplianceReport; digest: string }): React.JSX.Element {
  const { report, digest } = props;
  const status = (ok: boolean): React.JSX.Element => (
    <span className={ok ? 'status status-ok' : 'status status-bad'}>
      {ok ? '✓ Compliant' : '✗ Violations'}
    </span>
  );
  return (
    <div>
      <p>
        Generated <time dateTime={report.generatedAt}>{report.generatedAt}</time> ·{' '}
        {report.inventory.total} tenants · digest <code>{digest.slice(0, 12)}…</code>
      </p>

      <section aria-labelledby="iso-h">
        <h3 id="iso-h">Isolation {status(report.isolation.compliant)}</h3>
        <p>
          Missing project: {report.isolation.missingProject.length}; shared projects:{' '}
          {report.isolation.sharedProjects.length}
        </p>
      </section>

      <section aria-labelledby="res-h">
        <h3 id="res-h">Residency {status(report.residency.compliant)}</h3>
        {report.residency.violations.length === 0 ? (
          <p>No residency violations.</p>
        ) : (
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
              {report.residency.violations.map((v) => (
                <tr key={v.tenantId}>
                  <td>{v.tenantId}</td>
                  <td>{v.region}</td>
                  <td>{v.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="inv-h">
        <h3 id="inv-h">Inventory</h3>
        <table>
          <caption>Tenants by status</caption>
          <thead>
            <tr>
              <th scope="col">Status</th>
              <th scope="col">Count</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(report.inventory.byStatus).map(([s, n]) => (
              <tr key={s}>
                <th scope="row">{s}</th>
                <td>{n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
