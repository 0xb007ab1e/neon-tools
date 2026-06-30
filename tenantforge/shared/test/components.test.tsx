import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { AppShell, Breadcrumbs, Card, InfoTip, Pill, Tabs, type NavGroup } from '../ui/index';

/**
 * Branch- and behavior-completeness tests for the shared design system (shared/ui/*) that the
 * shell.test.tsx suite doesn't already exercise: presentational fallbacks (default tone, alternate
 * heading level, mid-trail breadcrumb), the InfoTip hoverable/outside-dismiss paths (WCAG 1.4.13),
 * and the AppShell off-canvas drawer's focus-trap cycling + best-effort persistence failure path.
 *
 * These close the remaining uncovered branches so the shared-system coverage gate (90% baseline,
 * shared/vitest.config.ts) holds with margin — shared/ui is reused across all three SPAs, so a
 * regression here is the highest-leverage thing to catch.
 */

afterEach(() => {
  vi.restoreAllMocks();
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

beforeEach(() => {
  window.location.hash = '';
});

describe('shared/ui — presentational fallbacks', () => {
  it('Pill defaults to the neutral tone when none is given', () => {
    render(<Pill>queued</Pill>);
    const pill = screen.getByText('queued');
    expect(pill).toHaveClass('cf-pill', 'cf-pill-neutral');
  });

  it('Card renders an <h3> when headingLevel is 3', () => {
    render(
      <Card title="Sub-panel" headingLevel={3}>
        <p>body</p>
      </Card>,
    );
    const heading = screen.getByRole('heading', { name: 'Sub-panel' });
    expect(heading.tagName).toBe('H3');
  });

  it('Breadcrumbs renders a middle crumb without an href as plain text (not a link, not current)', () => {
    render(
      <Breadcrumbs
        items={[
          { label: 'Home', href: '#/' },
          { label: 'Section' }, // no href, NOT the last crumb → plain <span>, not aria-current
          { label: 'Leaf' },
        ]}
      />,
    );
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    const middle = within(nav).getByText('Section');
    expect(middle.tagName).toBe('SPAN');
    expect(middle).not.toHaveAttribute('aria-current');
    expect(within(nav).queryByRole('link', { name: 'Section' })).toBeNull();
    // The last crumb is still the current page.
    expect(within(nav).getByText('Leaf')).toHaveAttribute('aria-current', 'page');
  });

  it('Tabs without an onSelect handler renders plain links (default navigation, no preventDefault)', () => {
    render(
      <Tabs
        label="Settings tabs"
        items={[
          { id: 'general', label: 'General' },
          { id: 'advanced', label: 'Advanced' },
        ]}
        activeId="general"
        href={(id) => `#/settings/${id}`}
        // onSelect intentionally omitted → the onClick prop is undefined (link does its own nav).
      />,
    );
    const link = screen.getByRole('link', { name: 'Advanced' });
    expect(link).toHaveAttribute('href', '#/settings/advanced');
    // A click is NOT prevented (no handler) — defaultPrevented stays false.
    const evt = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);
  });
});

describe('shared/ui — InfoTip hoverable + outside-dismiss (WCAG 1.4.13)', () => {
  it('opens on pointer hover and stays open when the pointer moves onto the bubble (hoverable)', async () => {
    render(<InfoTip label="About retries">Retries use exponential backoff.</InfoTip>);
    const root = screen.getByRole('button', { name: 'About retries' }).parentElement!;
    fireEvent.mouseEnter(root);
    const bubble = await screen.findByRole('tooltip');
    // Leaving the trigger schedules a close, but entering the bubble cancels it (grace).
    fireEvent.mouseLeave(root);
    fireEvent.mouseEnter(bubble);
    // Still open after the grace window would have elapsed.
    await new Promise((r) => setTimeout(r, 160));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('closes after the grace timeout when the pointer leaves without entering the bubble', async () => {
    render(<InfoTip label="About backoff">Body.</InfoTip>);
    const root = screen.getByRole('button', { name: 'About backoff' }).parentElement!;
    fireEvent.mouseEnter(root);
    expect(await screen.findByRole('tooltip')).toBeInTheDocument();
    fireEvent.mouseLeave(root);
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });

  it('an outside pointerdown dismisses the open bubble without moving the pointer back', async () => {
    render(
      <div>
        <InfoTip label="About scope">Scope of this setting.</InfoTip>
        <button type="button">Elsewhere</button>
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'About scope' }));
    expect(await screen.findByRole('tooltip')).toBeInTheDocument();
    // pointerdown on an element outside the InfoTip root closes it (1.4.13 dismissible).
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }));
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });

  it('an outside focusin dismisses the open bubble', async () => {
    render(
      <div>
        <InfoTip label="About region">Where data lives.</InfoTip>
        <input aria-label="other field" />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'About region' }));
    expect(await screen.findByRole('tooltip')).toBeInTheDocument();
    fireEvent.focusIn(screen.getByLabelText('other field'));
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });
});

const navGroups: NavGroup[] = [
  {
    items: [
      { id: 'overview', label: 'Overview', icon: '◆' },
      { id: 'billing', label: 'Billing', icon: '$' },
    ],
  },
];

/** Harness mirroring how a SPA composes AppShell (provides a mainRef). */
function ShellHarness(): React.ReactElement {
  const mainRef = useRef<HTMLElement>(null);
  return (
    <AppShell
      brand={<span>TenantForge</span>}
      navGroups={navGroups}
      navAriaLabel="Sections"
      activeId="overview"
      href={(id) => `#/${id}`}
      onSelect={() => undefined}
      topbarContext="Acme Inc"
      mainLabel="Overview section"
      mainRef={mainRef}
    >
      <h1 tabIndex={-1}>Overview</h1>
    </AppShell>
  );
}

describe('shared/ui — AppShell drawer focus trap (Tab cycling)', () => {
  const hamburger = (): HTMLElement => screen.getByRole('button', { name: 'Open navigation menu' });

  it('Tab on the last focusable element wraps focus back to the first (forward trap)', async () => {
    render(<ShellHarness />);
    fireEvent.click(hamburger());
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    await waitFor(() => expect(nav.contains(document.activeElement)).toBe(true));
    const focusable = nav.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    last.focus();
    expect(document.activeElement).toBe(last);
    // Tab at the end cycles to the first (capture-phase keydown handler).
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
  });

  it('Shift+Tab on the first focusable element wraps focus to the last (backward trap)', async () => {
    render(<ShellHarness />);
    fireEvent.click(hamburger());
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    await waitFor(() => expect(nav.contains(document.activeElement)).toBe(true));
    const focusable = nav.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});

describe('shared/ui — AppShell persistence best-effort', () => {
  it('survives a localStorage write failure when toggling collapse (no throw)', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    // Render + toggle should not throw even though persisting the preference fails.
    expect(() => {
      render(<ShellHarness />);
      fireEvent.click(screen.getByRole('button', { name: 'Collapse navigation' }));
    }).not.toThrow();
    expect(setItem).toHaveBeenCalled();
    // The UI still reflects the toggled state despite the failed persist.
    expect(screen.getByRole('button', { name: 'Expand navigation' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('falls back to expanded when reading the persisted preference throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    render(<ShellHarness />);
    // readCollapsed() swallowed the error and defaulted to expanded.
    expect(screen.getByRole('button', { name: 'Collapse navigation' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});
