import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Features, type SessionView } from './api.js';
import { loadStripe } from './loaders.js';
import {
  OverviewView,
  BillingView,
  PlanView,
  PaymentView,
  DangerZoneView,
  EvidenceView,
} from './views.js';
import { AppShell, type NavGroup, type NavItem } from '../../shared/ui/index.js';

/**
 * The portal sections (hash-routed). The Evidence section is conditional on `features.evidence`; the
 * Danger zone is conditional on `features.destructiveActions` (the two flags are independent).
 */
export type Section = 'overview' | 'billing' | 'plan' | 'payment' | 'evidence' | 'danger';

const SECTION_LABELS: Record<Section, string> = {
  overview: 'Overview',
  billing: 'Billing',
  plan: 'Plan',
  payment: 'Payment method',
  evidence: 'Compliance evidence',
  danger: 'Danger zone',
};

/** Decorative section icons for the sidebar (aria-hidden; the label carries the meaning). */
const SECTION_ICONS: Record<Section, string> = {
  overview: '\u{1F3E0}', // house
  billing: '\u{1F4B3}', // card
  plan: '\u{1F4CB}', // clipboard
  payment: '\u{1F3E6}', // bank
  evidence: '\u{1F4DC}', // scroll
  danger: '\u{26A0}', // warning sign
};

/**
 * Resolve + apply the light/dark theme. Defaults to the OS `prefers-color-scheme`, with an in-app
 * toggle that persists the explicit choice (localStorage). Applied via `data-theme` on the root so
 * the token CSS can switch; `prefers-reduced-motion` is honored in CSS (accessibility-first).
 */
function useTheme(): { theme: 'light' | 'dark'; toggle: () => void } {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      const stored = localStorage.getItem('tf-portal-theme');
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
        localStorage.setItem('tf-portal-theme', next);
      } catch {
        /* ignore persistence failure */
      }
      return next;
    });
  }, []);
  return { theme, toggle };
}

/** An accessible light/dark theme toggle (labelled; shows the current theme + what it switches to). */
function ThemeToggle(props: { theme: 'light' | 'dark'; onToggle: () => void }): React.ReactElement {
  const next = props.theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={props.onToggle}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
    >
      <span aria-hidden="true">{props.theme === 'dark' ? '\u{1F319}' : '\u{2600}'}</span>
      <span className="theme-toggle-label">{props.theme === 'dark' ? 'Dark' : 'Light'}</span>
    </button>
  );
}

/** Read the section from the URL hash, defaulting to Overview. */
function sectionFromHash(): Section {
  const raw = window.location.hash.replace(/^#\/?/, '');
  return (Object.keys(SECTION_LABELS) as Section[]).includes(raw as Section)
    ? (raw as Section)
    : 'overview';
}

/** Read `code` + `state` from the IdP redirect callback (QUERY params, not the fragment). */
function readCallback(): { code: string; state: string } | null {
  const q = new URLSearchParams(window.location.search);
  const code = q.get('code');
  const state = q.get('state');
  return code !== null && code !== '' && state !== null && state !== '' ? { code, state } : null;
}

/** Strip the OAuth callback params from the URL so they don't linger in history/refreshes. */
function scrubCallbackUrl(): void {
  window.history.replaceState(null, '', `${window.location.pathname}#/overview`);
}

/** Root portal app: load session → login (OIDC code flow / dev token) or the signed-in shell. */
export function App(): React.ReactElement {
  const { theme, toggle } = useTheme();
  // undefined = still loading; null = signed out; SessionView = signed in.
  const [session, setSession] = useState<SessionView | null | undefined>(undefined);
  const [authMode, setAuthMode] = useState<'oidc' | 'token'>('oidc');
  const [loginError, setLoginError] = useState<string | null>(null);

  // On load: if returning from the IdP with ?code&state, complete the server-side exchange (the SPA
  // never sees a token); otherwise probe the existing session. The login mode comes from /api/config.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      api.config().then(
        (cfg) => !cancelled && setAuthMode(cfg.auth.mode),
        () => {
          /* config is best-effort; default to oidc */
        },
      );
      const cb = readCallback();
      if (cb !== null) {
        try {
          const view = await api.loginWithCode(cb.code, cb.state);
          if (cancelled) return;
          scrubCallbackUrl(); // drop code/state from the URL (single-use; already consumed server-side)
          setSession(view);
          return;
        } catch (e) {
          if (cancelled) return;
          scrubCallbackUrl();
          setLoginError(e instanceof Error ? e.message : 'Sign-in failed');
        }
      }
      try {
        setSession(await api.session());
      } catch {
        if (!cancelled) setSession(null);
      }
    })();
    return () => {
      cancelled = true;
    };
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
        mode={authMode}
        error={loginError}
        theme={theme}
        onToggleTheme={toggle}
        onStartOidc={async () => {
          setLoginError(null);
          try {
            // The SERVER pins state/nonce/verifier + returns the authorize URL; we just redirect.
            const { authorizeUrl } = await api.loginStart();
            window.location.assign(authorizeUrl);
          } catch (e) {
            setLoginError(e instanceof Error ? e.message : 'Could not start sign-in');
          }
        }}
        onDevToken={async (token) => {
          setLoginError(null);
          try {
            setSession(await api.login(token));
          } catch (e) {
            setLoginError(e instanceof Error ? e.message : 'Sign-in failed');
          }
        }}
      />
    );
  }
  return (
    <SignedInView
      session={session}
      theme={theme}
      onToggleTheme={toggle}
      onLogout={async () => {
        try {
          await api.logout();
        } finally {
          window.location.hash = '';
          setSession(null);
        }
      }}
    />
  );
}

/**
 * The signed-out view: in `oidc` mode a single button kicks off the **server-driven** Authorization
 * Code + PKCE flow (the server mints + pins state/nonce/verifier; the SPA only redirects to the
 * returned authorize URL). In `token` mode (dev / no IdP) a token field posts to the dev login path.
 */
function LoginView(props: {
  mode: 'oidc' | 'token';
  error: string | null;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onStartOidc: () => Promise<void>;
  onDevToken: (token: string) => Promise<void>;
}): React.ReactElement {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [devToken, setDevToken] = useState('');
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <h1 id="main-heading" ref={headingRef} tabIndex={-1}>
          Sign in
        </h1>
        <ThemeToggle theme={props.theme} onToggle={props.onToggleTheme} />
      </header>
      <main className="card">
        <p className="lede">Sign in with your identity provider to manage your account.</p>
        {props.error !== null && (
          <p className="alert" role="alert">
            {props.error}
          </p>
        )}
        {props.mode === 'oidc' ? (
          <button type="button" onClick={() => void props.onStartOidc()}>
            Sign in with your identity provider
          </button>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void props.onDevToken(devToken);
            }}
          >
            <label htmlFor="dev-token">
              Portal token <span className="hint">(development / token mode)</span>
            </label>
            <input
              id="dev-token"
              type="password"
              autoComplete="off"
              value={devToken}
              onChange={(e) => setDevToken(e.target.value)}
              required
            />
            <button type="submit" disabled={devToken === ''}>
              Sign in
            </button>
          </form>
        )}
      </main>
    </div>
  );
}

/**
 * The signed-in shell: the Cloudflare-style {@link AppShell} (left sidebar + top account bar +
 * content), with the section's title as the focused `<h1>` on each route change.
 *
 * Behavior is unchanged from the previous top-nav layout — only the information architecture/layout
 * moved to the shell. Flag-gated sections (Danger zone, Evidence) appear in the sidebar only when
 * their server feature flag is on, and a deep link to a hidden section redirects to Overview. All
 * authorization/CSRF/tenant-scoping remains server-side; the sidebar visibility is UX, not a control.
 */
function SignedInView(props: {
  session: SessionView;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onLogout: () => Promise<void>;
}): React.ReactElement {
  const [section, setSection] = useState<Section>(sectionFromHash);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const features: Features = props.session.features;

  // Keep the section in sync with the hash (back/forward + deep links).
  useEffect(() => {
    const onHash = (): void => setSection(sectionFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Guard against landing on a hidden section (a flag-gated section whose server flag is off):
  // redirect to Overview, so a deep link / stale hash can't show a section with no data.
  useEffect(() => {
    if (
      (section === 'danger' && !features.destructiveActions) ||
      (section === 'evidence' && !features.evidence)
    ) {
      window.location.hash = '#/overview';
    }
  }, [section, features.destructiveActions, features.evidence]);

  // Move focus to the section heading on each route change (a11y: announce + orient the screen reader).
  useEffect(() => {
    headingRef.current?.focus();
  }, [section]);

  const visibleSections: Section[] = (Object.keys(SECTION_LABELS) as Section[]).filter(
    (s) =>
      (s !== 'danger' || features.destructiveActions) && (s !== 'evidence' || features.evidence),
  );

  const toNavItem = (s: Section): NavItem => ({
    id: s,
    label: SECTION_LABELS[s],
    icon: SECTION_ICONS[s],
    variant: s === 'danger' ? 'danger' : 'default',
  });

  // Group the sidebar the way Cloudflare does: a primary group + an "Account settings" group, with
  // the flag-gated Danger zone last. Only visible (flag-enabled) sections are included.
  const accountIds: Section[] = ['billing', 'plan', 'payment'];
  const primary: NavItem[] = visibleSections.filter((s) => s === 'overview').map(toNavItem);
  const account: NavItem[] = visibleSections.filter((s) => accountIds.includes(s)).map(toNavItem);
  const compliance: NavItem[] = visibleSections.filter((s) => s === 'evidence').map(toNavItem);
  const danger: NavItem[] = visibleSections.filter((s) => s === 'danger').map(toNavItem);

  const navGroups: NavGroup[] = [
    { items: primary },
    { heading: 'Account settings', items: account },
    ...(compliance.length > 0 ? [{ heading: 'Compliance', items: compliance }] : []),
    ...(danger.length > 0 ? [{ items: danger }] : []),
  ];

  const navigate = (id: string): void => {
    window.location.hash = `#/${id}`;
  };

  const brand = (
    <>
      <span className="cf-brand-mark" aria-hidden="true">
        TF
      </span>
      <span className="cf-brand-name">TenantForge</span>
    </>
  );

  const topbarActions = (
    <>
      <ThemeToggle theme={props.theme} onToggle={props.onToggleTheme} />
      <button type="button" className="link-button" onClick={() => void props.onLogout()}>
        Sign out
      </button>
    </>
  );

  return (
    <AppShell
      brand={brand}
      navGroups={navGroups}
      navAriaLabel="Account sections"
      activeId={section}
      href={(id) => `#/${id}`}
      onSelect={navigate}
      topbarContext="TenantForge Account"
      topbarActions={topbarActions}
      mainLabel={`${SECTION_LABELS[section]} section`}
      collapseStorageKey="tf-portal-sidebar-collapsed"
    >
      <h1 id="section-heading" ref={headingRef} tabIndex={-1}>
        {SECTION_LABELS[section]}
      </h1>
      {section === 'overview' && <OverviewView />}
      {section === 'billing' && <BillingView />}
      {section === 'plan' && <PlanView />}
      {section === 'payment' && <PaymentView loadStripe={loadStripe} />}
      {section === 'evidence' && features.evidence && <EvidenceView />}
      {section === 'danger' && features.destructiveActions && <DangerZoneView />}
    </AppShell>
  );
}
