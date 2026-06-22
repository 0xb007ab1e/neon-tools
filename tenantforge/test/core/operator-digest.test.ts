import { describe, expect, it } from 'vitest';
import type { AuditAnomaly, CostAnomaly, OperatorDigestInput } from '../../src/core/index.js';
import { buildOperatorDigest, formatOperatorDigest } from '../../src/core/index.js';

const AT = '2026-06-22T00:00:00.000Z';

/** A clean input (everything ok) that individual tests selectively perturb. */
function input(overrides: Partial<OperatorDigestInput> = {}): OperatorDigestInput {
  return {
    generatedAt: AT,
    auditAnomalies: [],
    costAnomalies: [],
    drift: { target: '0007', pendingTenants: 0 },
    retention: { eligible: 0, pending: 0 },
    usage: { alertedTenants: 0, scanFailures: 0 },
    ...overrides,
  };
}

const auditAnomaly = (kind: AuditAnomaly['kind']): AuditAnomaly => ({
  kind,
  count: 5,
  events: ['e'],
});
const costAnomaly = (kind: CostAnomaly['kind']): CostAnomaly => ({
  kind,
  tenantId: 't1',
  costUsd: 10,
  priceUsd: 5,
  marginUsd: -5,
});

const categoryOf = (d: ReturnType<typeof buildOperatorDigest>, name: string) =>
  d.categories.find((c) => c.category === name)!;

describe('buildOperatorDigest', () => {
  it('reports ok / all clear when every detector is clean', () => {
    const d = buildOperatorDigest(input());
    expect(d.severity).toBe('ok');
    expect(d.totalIssues).toBe(0);
    expect(d.headline).toBe('ok: all clear');
    expect(d.categories.map((c) => c.category).sort()).toEqual([
      'audit',
      'cost',
      'drift',
      'retention',
      'usage',
    ]);
    expect(d.categories.every((c) => c.severity === 'ok')).toBe(true);
    expect(categoryOf(d, 'drift').detail).toBe('fleet at target 0007');
    expect(categoryOf(d, 'retention').detail).toBe('none past retention (0 within window)');
    expect(categoryOf(d, 'usage').detail).toBe('usage within allowances');
  });

  it('escalates audit to critical on an error spike, warning on a cluster', () => {
    expect(
      buildOperatorDigest(input({ auditAnomalies: [auditAnomaly('error-spike')] })).severity,
    ).toBe('critical');
    const warn = buildOperatorDigest(input({ auditAnomalies: [auditAnomaly('actor-errors')] }));
    expect(categoryOf(warn, 'audit').severity).toBe('warning');
    expect(categoryOf(warn, 'audit').detail).toBe('1 anomaly');
  });

  it('escalates cost to critical when a tenant is unprofitable, warning otherwise', () => {
    expect(
      buildOperatorDigest(input({ costAnomalies: [costAnomaly('unprofitable')] })).severity,
    ).toBe('critical');
    const warn = buildOperatorDigest(
      input({ costAnomalies: [costAnomaly('low-margin'), costAnomaly('high-cost')] }),
    );
    expect(categoryOf(warn, 'cost').severity).toBe('warning');
    expect(categoryOf(warn, 'cost').detail).toBe('2 anomalies'); // plural form
  });

  it('flags fleet drift as a warning when tenants are behind target', () => {
    const d = buildOperatorDigest(input({ drift: { target: '0007', pendingTenants: 1 } }));
    expect(categoryOf(d, 'drift').severity).toBe('warning');
    expect(categoryOf(d, 'drift').detail).toBe('1 tenant behind target 0007'); // singular
  });

  it('shows n/a target and handles a multi-tenant drift detail', () => {
    const d = buildOperatorDigest(input({ drift: { target: null, pendingTenants: 3 } }));
    expect(categoryOf(d, 'drift').detail).toBe('3 tenants behind target n/a');
  });

  it('flags retention backlog (eligible-for-purge) as a warning', () => {
    const d = buildOperatorDigest(input({ retention: { eligible: 2, pending: 4 } }));
    expect(categoryOf(d, 'retention').severity).toBe('warning');
    expect(categoryOf(d, 'retention').detail).toBe(
      '2 tenants past retention, awaiting purge (4 within window)',
    );
  });

  it('treats a metering failure as a warning but an over-allowance tenant as info', () => {
    expect(
      categoryOf(
        buildOperatorDigest(input({ usage: { alertedTenants: 0, scanFailures: 1 } })),
        'usage',
      ).severity,
    ).toBe('warning');
    const info = buildOperatorDigest(input({ usage: { alertedTenants: 1, scanFailures: 0 } }));
    expect(categoryOf(info, 'usage').severity).toBe('info');
    expect(categoryOf(info, 'usage').detail).toBe('1 tenant over allowance');
    // Both signals present → warning wins, both phrases shown.
    expect(
      categoryOf(
        buildOperatorDigest(input({ usage: { alertedTenants: 2, scanFailures: 1 } })),
        'usage',
      ).detail,
    ).toBe('2 tenants over allowance, 1 metering failure');
  });

  it('rolls up to the most-urgent severity, orders categories by it, and counts non-ok issues', () => {
    const d = buildOperatorDigest(
      input({
        costAnomalies: [costAnomaly('unprofitable')], // critical, count 1
        drift: { target: '0007', pendingTenants: 2 }, // warning, count 2
        usage: { alertedTenants: 1, scanFailures: 0 }, // info, count 1
      }),
    );
    expect(d.severity).toBe('critical');
    expect(d.categories[0]?.category).toBe('cost'); // most urgent first
    expect(d.totalIssues).toBe(4); // 1 + 2 + 1, ok categories contribute 0
    expect(d.headline).toBe('critical: 4 issues across cost, drift, usage');
  });

  it('uses singular "issue" in the headline for a single issue', () => {
    const d = buildOperatorDigest(input({ drift: { target: '0007', pendingTenants: 1 } }));
    expect(d.headline).toBe('warning: 1 issue across drift');
  });
});

describe('formatOperatorDigest', () => {
  it('renders the headline, timestamp, and a line per category', () => {
    const text = formatOperatorDigest(
      buildOperatorDigest(input({ drift: { target: '0007', pendingTenants: 1 } })),
    );
    expect(text).toContain('Operator digest — warning: 1 issue across drift');
    expect(text).toContain(`Generated: ${AT}`);
    expect(text).toContain('[warning] drift: 1 tenant behind target 0007');
    expect(text).toContain('[ok] audit: no audit anomalies');
  });
});
