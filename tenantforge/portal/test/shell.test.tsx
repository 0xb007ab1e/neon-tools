import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import {
  AppShell,
  Breadcrumbs,
  Card,
  DataTable,
  Pill,
  Sidebar,
  SettingsRow,
  StatGrid,
  StatTile,
  Tabs,
  type Column,
  type NavGroup,
} from '../../shared/ui/index';

/**
 * Unit + a11y tests for the shared Cloudflare-style shell components (shared/ui/*). These are the
 * reusable building blocks the portal (and, next, the dashboard) compose. We assert their semantic
 * structure (landmarks, headings, aria-current, table scopes), keyboard/behavior contracts, and a
 * clean axe pass. The components are presentational/prop-driven; no security logic lives here.
 */

const groups: NavGroup[] = [
  { items: [{ id: 'overview', label: 'Overview', icon: '◆' }] },
  {
    heading: 'Account settings',
    items: [
      { id: 'billing', label: 'Billing', icon: '$' },
      { id: 'danger', label: 'Danger zone', icon: '!', variant: 'danger' },
    ],
  },
];

afterEach(() => {
  vi.restoreAllMocks();
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

/** A tiny harness that wires AppShell's mainRef the way a consumer would. */
function ShellHarness(props: {
  activeId: string;
  onSelect?: (id: string) => void;
}): React.ReactElement {
  const mainRef = useRef<HTMLElement>(null);
  return (
    <AppShell
      brand={<span>TenantForge</span>}
      navGroups={groups}
      navAriaLabel="Account sections"
      activeId={props.activeId}
      href={(id) => `#/${id}`}
      onSelect={props.onSelect ?? (() => undefined)}
      topbarContext="Acme Inc"
      topbarActions={<button type="button">Sign out</button>}
      mainLabel="Overview section"
      mainRef={mainRef}
    >
      <h1 tabIndex={-1}>Overview</h1>
      <p>content</p>
    </AppShell>
  );
}

describe('shared/ui — AppShell + Sidebar + TopBar', () => {
  it('renders nav + main landmarks, a skip link, and the active item via aria-current; no a11y violations', async () => {
    const { container } = render(<ShellHarness activeId="overview" />);
    // The sidebar is a labelled <nav> landmark; items are real links.
    const nav = screen.getByRole('navigation', { name: 'Account sections' });
    const overview = within(nav).getByRole('link', { name: 'Overview' });
    expect(overview).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Billing' })).not.toHaveAttribute('aria-current');
    // main landmark + skip link.
    expect(screen.getByRole('main', { name: 'Overview section' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#main');
    // The grouped heading renders.
    expect(screen.getByText('Account settings')).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('invokes onSelect with the item id (keyboard-operable link)', () => {
    const onSelect = vi.fn();
    render(<ShellHarness activeId="overview" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('link', { name: 'Billing' }));
    expect(onSelect).toHaveBeenCalledWith('billing');
  });

  it('collapse toggle flips aria-expanded and persists the preference', () => {
    render(<ShellHarness activeId="overview" />);
    // Scope to the rail-collapse control by its specific name (the hamburger also matches /navigation/).
    const toggle = screen.getByRole('button', { name: 'Collapse navigation' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    // After collapsing, its accessible name becomes "Expand navigation".
    expect(screen.getByRole('button', { name: 'Expand navigation' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(localStorage.getItem('tf-sidebar-collapsed')).toBe('1');
  });

  it('Sidebar marks a danger-variant item and keeps the label as its accessible name when collapsed', () => {
    render(
      <Sidebar
        brand={<span>Brand</span>}
        groups={groups}
        activeId="danger"
        ariaLabel="Sections"
        collapsed
        onToggleCollapsed={() => undefined}
        href={(id) => `#/${id}`}
        onSelect={() => undefined}
      />,
    );
    // Even collapsed, the link's accessible name is the label (icons are aria-hidden).
    expect(screen.getByRole('link', { name: 'Danger zone' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});

describe('shared/ui — responsive nav drawer (narrow viewports)', () => {
  /** The drawer nav is the labelled <nav> landmark; the backdrop closes it on click. */
  const hamburger = (): HTMLElement => screen.getByRole('button', { name: 'Open navigation menu' });

  it('renders a hamburger toggle wired to the nav via aria-controls, collapsed by default', () => {
    render(<ShellHarness activeId="overview" />);
    const btn = hamburger();
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    const nav = screen.getByRole('navigation', { name: 'Account sections' });
    expect(btn).toHaveAttribute('aria-controls', nav.id);
    expect(nav.id).toBeTruthy();
  });

  it('opens the drawer (aria-expanded reflects state) and moves focus into it', async () => {
    render(<ShellHarness activeId="overview" />);
    fireEvent.click(hamburger());
    expect(hamburger()).toHaveAttribute('aria-expanded', 'true');
    const nav = screen.getByRole('navigation', { name: 'Account sections' });
    // Focus moved into the drawer (the first focusable element).
    await waitFor(() => expect(nav.contains(document.activeElement)).toBe(true));
    expect((await axe(document.body)).violations).toEqual([]);
  });

  it('Esc closes the drawer and returns focus to the hamburger', async () => {
    render(<ShellHarness activeId="overview" />);
    fireEvent.click(hamburger());
    await waitFor(() =>
      expect(
        screen
          .getByRole('navigation', { name: 'Account sections' })
          .contains(document.activeElement),
      ).toBe(true),
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(hamburger()).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(document.activeElement).toBe(hamburger()));
  });

  it('backdrop click closes the drawer', () => {
    const { container } = render(<ShellHarness activeId="overview" />);
    fireEvent.click(hamburger());
    expect(hamburger()).toHaveAttribute('aria-expanded', 'true');
    const backdrop = container.querySelector('.cf-drawer-backdrop');
    expect(backdrop).not.toBeNull();
    expect(backdrop).not.toHaveAttribute('hidden'); // shown while open
    fireEvent.click(backdrop!);
    expect(hamburger()).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('.cf-drawer-backdrop')).toHaveAttribute('hidden');
  });

  it('choosing a nav item navigates and closes the drawer', () => {
    const onSelect = vi.fn();
    render(<ShellHarness activeId="overview" onSelect={onSelect} />);
    fireEvent.click(hamburger());
    fireEvent.click(screen.getByRole('link', { name: 'Billing' }));
    expect(onSelect).toHaveBeenCalledWith('billing');
    expect(hamburger()).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('shared/ui — Card / SettingsRow / StatTile', () => {
  it('Card is a labelled region with a heading + optional actions; SettingsRow associates its label', async () => {
    const { container } = render(
      <Card title="Payment method" description="How you pay" actions={<button>Edit</button>}>
        <SettingsRow
          label="Default card"
          description="Used for renewals"
          value="•••• 4242"
          control={<button type="button">Edit</button>}
        />
        <SettingsRow label="Plan" controlId="plan-input" control={<input id="plan-input" />} />
      </Card>,
    );
    expect(screen.getByRole('region', { name: 'Payment method' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Payment method' })).toBeInTheDocument();
    // The controlId variant renders a real <label for> association.
    expect(screen.getByLabelText('Plan')).toBe(container.querySelector('#plan-input'));
    expect((await axe(container)).violations).toEqual([]);
  });

  it('StatTile shows label + value (+ optional hint)', () => {
    render(
      <StatGrid>
        <StatTile label="Region" value="aws-us-east-1" />
        <StatTile label="Plan" value="$49.00" hint="per period" />
      </StatGrid>,
    );
    expect(screen.getByText('Region')).toBeInTheDocument();
    expect(screen.getByText('aws-us-east-1')).toBeInTheDocument();
    expect(screen.getByText('per period')).toBeInTheDocument();
  });
});

describe('shared/ui — DataTable / Pill', () => {
  interface Row {
    id: string;
    name: string;
    status: 'active' | 'failed';
  }
  const columns: Column<Row>[] = [
    { key: 'name', header: 'Name', isRowHeader: true, cell: (r) => r.name },
    {
      key: 'status',
      header: 'Status',
      cell: (r) => <Pill tone={r.status === 'active' ? 'success' : 'danger'}>{r.status}</Pill>,
    },
  ];

  it('renders a semantic table with caption, col + row scopes, and a status pill; no a11y violations', async () => {
    const rows: Row[] = [
      { id: '1', name: 'alpha', status: 'active' },
      { id: '2', name: 'beta', status: 'failed' },
    ];
    const { container } = render(
      <DataTable
        caption="Tenants"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        empty="none"
      />,
    );
    expect(screen.getByRole('table', { name: 'Tenants' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: 'alpha' })).toBeInTheDocument();
    // The pill text carries the status (not color-only).
    expect(screen.getByText('active')).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('renders the empty state when there are no rows', () => {
    render(
      <DataTable
        caption="Tenants"
        columns={columns}
        rows={[]}
        rowKey={(r) => r.id}
        empty="No tenants yet."
      />,
    );
    expect(screen.getByText('No tenants yet.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('shared/ui — Breadcrumbs / Tabs', () => {
  it('Breadcrumbs marks the last crumb aria-current and links the earlier ones', async () => {
    const { container } = render(
      <Breadcrumbs
        items={[
          { label: 'Home', href: '#/' },
          { label: 'Billing', href: '#/billing' },
          { label: 'Invoice' },
        ]}
      />,
    );
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByRole('link', { name: 'Home' })).toBeInTheDocument();
    expect(within(nav).getByText('Invoice')).toHaveAttribute('aria-current', 'page');
    expect((await axe(container)).violations).toEqual([]);
  });

  it('Tabs marks the active tab and calls onSelect', () => {
    const onSelect = vi.fn();
    render(
      <Tabs
        label="Billing tabs"
        items={[
          { id: 'invoices', label: 'Invoices' },
          { id: 'history', label: 'History' },
        ]}
        activeId="invoices"
        href={(id) => `#/billing/${id}`}
        onSelect={onSelect}
      />,
    );
    expect(screen.getByRole('link', { name: 'Invoices' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByRole('link', { name: 'History' }));
    expect(onSelect).toHaveBeenCalledWith('history');
  });
});

// Reset hashes between specs (some components write to location indirectly via consumers).
beforeEach(() => {
  window.location.hash = '';
});
