import { fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';

const report = {
  generatedAt: '2026-06-20T00:00:00.000Z',
  inventory: {
    total: 2,
    byStatus: { provisioning: 0, active: 2, suspended: 0, offboarding: 0, deleted: 0 },
  },
  isolation: { compliant: true, missingProject: [], sharedProjects: [] },
  residency: {
    compliant: false,
    allowedRegions: ['aws-us-east-1'],
    byJurisdiction: { us: 1, eu: 1 },
    violations: [
      { tenantId: 'tenant-b', region: 'aws-eu-central-1', reason: 'region not in org allow-list' },
    ],
  },
};
const drift = {
  latest: '0003',
  totalVersions: 3,
  summary: { total: 2, atLatest: 1, drifted: 1, withFailures: 0 },
};
const cost = {
  generatedAt: '2026-06-20T00:00:00.000Z',
  rows: [{ tenantId: 'tenant-a', costUsd: 10, priceUsd: 5, marginUsd: -5, unprofitable: true }],
  unmetered: [],
  totals: { tenants: 1, costUsd: 10, priceUsd: 5, marginUsd: -5, unprofitable: 1, unpriced: 0 },
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let authed = false;
beforeEach(() => {
  authed = false;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/session') && method === 'GET') {
        return Promise.resolve(authed ? json({ id: 'op', role: 'admin' }) : json({}, 401));
      }
      if (url.endsWith('/session') && method === 'POST') {
        authed = true;
        return Promise.resolve(json({ id: 'op', role: 'admin' }));
      }
      if (url.endsWith('/compliance'))
        return Promise.resolve(json({ report, digest: 'abc123def456' }));
      if (url.endsWith('/drift')) return Promise.resolve(json(drift));
      if (url.endsWith('/cost')) return Promise.resolve(json(cost));
      return Promise.resolve(json({}, 404));
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('dashboard App', () => {
  it('shows the login form when unauthenticated, no a11y violations', async () => {
    const { container } = render(<App />);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByLabelText('Operator token')).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('logs in and renders all three panels (compliance, drift, cost), no a11y violations', async () => {
    const { container } = render(<App />);
    fireEvent.change(await screen.findByLabelText('Operator token'), {
      target: { value: 'op-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText(/Signed in as/)).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Compliance' })).toBeInTheDocument();
    expect(await screen.findByText('region not in org allow-list')).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'Fleet migration drift' }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Cost & margin' })).toBeInTheDocument();
    // The unprofitable tenant row is rendered.
    expect(await screen.findByText('tenant-a')).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });
});
