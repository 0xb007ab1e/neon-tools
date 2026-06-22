import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TENANTFORGE } from '../meta.js';
import type { JsonObject } from '../core/index.js';
import { decodeCursor, encodeCursor } from '../core/index.js';
import type { TenantForge } from './lib.js';
import { runWithActor } from './actor-context.js';
import { runWithTrace, startTrace } from './trace-context.js';

/** Wrap a string as a tool text result. */
const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });

/** Pretty-print a value as a JSON text result. */
const json = (value: unknown) => text(JSON.stringify(value, null, 2));

/**
 * Build the TenantForge MCP server, exposing the control plane's tool surface over MCP. The
 * {@link TenantForge} service is injected so the server can be constructed (and tested) without
 * connecting to live infrastructure.
 *
 * Agent-safety hardening vs. the HTTP API (std-owasp-llm): `tf_provision` does **not** return the
 * connection secret into the model context (LLM06 sensitive-information disclosure). Irreversible /
 * SQL-bearing operations are kept off the agent surface (LLM08 excessive agency): purge is not
 * exposed at all, and fleet reconcile is exposed **read-only** (`tf_reconcile_plan` /
 * `tf_reconcile_history`) — execution stays on the CLI / gated dashboard. The read surface mirrors
 * the HTTP reads: compliance / cost (+ anomalies) / invoices / audit trail (`tf_audit`, which
 * subsumes the per-event billing histories via its `events` filter) / audit anomalies / retention /
 * plan catalog / signup-token status / credit balance — all read-only and carrying no secrets.
 * Money-moving and resource-creating ops (charge / refund / credit grant / plan settlement / signup
 * issue+redeem / data export) stay off MCP.
 *
 * @param tf - The TenantForge application service the tools delegate to.
 * @returns A configured (not-yet-connected) MCP server.
 */
export function createMcpServer(tf: TenantForge): McpServer {
  const server = new McpServer({ name: TENANTFORGE.id, version: TENANTFORGE.version });

  // Attribute control-plane actions taken via the agent surface to a single `mcp` operator in
  // the audit stream (the MCP transport carries no per-call principal). Each call also runs in a
  // fresh trace scope so its events share a correlation id and any Neon call is propagated.
  const asMcp = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithTrace(startTrace(), () => runWithActor({ id: 'mcp', role: 'admin' }, fn));

  server.registerTool(
    'tf_provision',
    {
      description:
        'Provision a tenant: create an isolated Neon project and record it. Idempotent on slug. ' +
        'The connection secret is issued to the secret store, not returned here.',
      inputSchema: {
        slug: z.string(),
        region: z.string().optional(),
        residency: z.enum(['us', 'eu', 'apac']).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ slug, region, residency, metadata }) =>
      asMcp(async () => {
        const outcome = await tf.provision({
          slug,
          ...(region ? { region } : {}),
          ...(residency ? { residency } : {}),
          ...(metadata ? { metadata: metadata as JsonObject } : {}),
        });
        // Deliberately omit outcome.connectionUri (a secret) from the model-visible result.
        return json({
          tenant: outcome.tenant,
          connectionSecretIssued: outcome.connectionUri !== null,
        });
      }),
  );

  server.registerTool(
    'tf_tenant',
    {
      description: 'Get a tenant by id.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const tenant = await tf.getTenant(id);
      return tenant ? json({ tenant }) : text(`tenant ${id} not found`);
    },
  );

  server.registerTool(
    'tf_list_tenants',
    {
      description:
        'List tenants, most-recent first. Optional status filter, page size, and ' +
        'keyset cursor. Pass the returned nextCursor back as `cursor` for the next page.',
      inputSchema: {
        status: z
          .enum(['provisioning', 'active', 'suspended', 'offboarding', 'deleted'])
          .optional(),
        limit: z.number().int().min(1).max(1000).optional(),
        cursor: z.string().optional(),
      },
    },
    async ({ status, limit, cursor }) => {
      const decoded = cursor === undefined ? null : decodeCursor(cursor);
      if (cursor !== undefined && decoded === null) return text('invalid cursor');
      const effectiveLimit = limit ?? 100;
      const tenants = await tf.listTenants({
        ...(status ? { status } : {}),
        limit: effectiveLimit,
        ...(decoded ? { cursor: decoded } : {}),
      });
      const last = tenants[tenants.length - 1];
      const nextCursor =
        tenants.length === effectiveLimit && last !== undefined
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null;
      return json({ tenants, nextCursor });
    },
  );

  server.registerTool(
    'tf_suspend',
    {
      description: 'Suspend an active tenant (reversible with tf_resume).',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => asMcp(async () => json({ tenant: await tf.suspend(id) })),
  );

  server.registerTool(
    'tf_resume',
    {
      description: 'Resume a suspended tenant back to active.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => asMcp(async () => json({ tenant: await tf.resume(id) })),
  );

  server.registerTool(
    'tf_offboard',
    {
      description:
        'Offboard a tenant: archive it — retain the Neon project (scaled to zero), stop serving. ' +
        'REVERSIBLE via tf_restore until purged. The irreversible hard-delete (purge) is intentionally ' +
        'not exposed to agents; run it via the CLI/HTTP control plane.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) =>
      asMcp(async () => {
        const outcome = await tf.offboard(id);
        return json({ tenant: outcome.tenant, archive: outcome.archive });
      }),
  );

  server.registerTool(
    'tf_restore',
    {
      description:
        'Restore an offboarded tenant back to active (un-archive), if still within its retention ' +
        'window. The inverse of tf_offboard; the tenant becomes routable again. Refused once the ' +
        'tenant is past retention (eligible for purge).',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => asMcp(async () => json({ tenant: await tf.restore(id) })),
  );

  // --- Read-only extension reports (no mutation, no secrets) ---

  /** Resolve optional ISO from/to into a period (default: current calendar month → now); null on a bad date. */
  const period = (from?: string, to?: string): { from: Date; to: Date } | null => {
    const end = to !== undefined ? new Date(to) : new Date();
    const start =
      from !== undefined ? new Date(from) : new Date(end.getFullYear(), end.getMonth(), 1);
    return Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())
      ? null
      : { from: start, to: end };
  };

  server.registerTool(
    'tf_compliance_report',
    {
      description:
        'Compliance attestation (read-only): physical isolation + data residency, plus erasure ' +
        'history when a persisted audit store is wired, with a SHA-256 integrity digest. Evidence, ' +
        'not a legal certification.',
      inputSchema: {},
    },
    async () => asMcp(async () => json(await tf.complianceReport())),
  );

  server.registerTool(
    'tf_operator_digest',
    {
      description:
        'Operator alert digest (read-only): one operational-health roll-up of all detectors — audit ' +
        'anomalies, cost anomalies, fleet drift, retention backlog, usage alerts — with an overall ' +
        'severity (ok/info/warning/critical). The single pane to check control-plane health.',
      inputSchema: {},
    },
    async () => asMcp(async () => json(await tf.operatorDigest())),
  );

  server.registerTool(
    'tf_cost_report',
    {
      description:
        'Per-tenant cost vs. price (margin) over a period (read-only estimate, not an invoice). ' +
        'from/to are ISO-8601; default is the current calendar month.',
      inputSchema: { from: z.string().optional(), to: z.string().optional() },
    },
    async ({ from, to }) => {
      const p = period(from, to);
      return p === null
        ? text('invalid from/to date (use ISO-8601)')
        : json(await tf.costReport(p));
    },
  );

  server.registerTool(
    'tf_invoice',
    {
      description:
        'Generate an invoice document for one tenant over a period (read-only artifact, not a ' +
        'charge). from/to are ISO-8601; default is the current calendar month.',
      inputSchema: { id: z.string(), from: z.string().optional(), to: z.string().optional() },
    },
    async ({ id, from, to }) => {
      const p = period(from, to);
      return p === null
        ? text('invalid from/to date (use ISO-8601)')
        : json(await tf.invoice(id, p));
    },
  );

  server.registerTool(
    'tf_invoices',
    {
      description:
        'Generate invoice documents for every active tenant over a period (read-only, ' +
        'failure-isolated). from/to are ISO-8601; default is the current calendar month.',
      inputSchema: { from: z.string().optional(), to: z.string().optional() },
    },
    async ({ from, to }) => {
      const p = period(from, to);
      return p === null
        ? text('invalid from/to date (use ISO-8601)')
        : json(await tf.invoiceFleet(p));
    },
  );

  server.registerTool(
    'tf_reconcile_plan',
    {
      description:
        'Preview a fleet reconcile plan (read-only): which active tenants are behind the target and ' +
        'the versions each would receive. Optional `target` version (default latest). EXECUTION is ' +
        'intentionally not exposed to agents — run it via the CLI / gated dashboard.',
      inputSchema: { target: z.string().optional() },
    },
    async ({ target }) =>
      json(await tf.reconcilePlan(target !== undefined ? { targetVersion: target } : undefined)),
  );

  server.registerTool(
    'tf_reconcile_history',
    {
      description:
        'Recent fleet reconcile history from the persisted audit trail (read-only). Empty unless an ' +
        'audit store is wired. `limit` caps the newest-first results (default 20).',
      inputSchema: { limit: z.number().int().min(1).max(1000).optional() },
    },
    async ({ limit }) => json({ history: await tf.reconcileHistory(limit) }),
  );

  server.registerTool(
    'tf_audit',
    {
      description:
        'Query the control-plane audit trail (read-only): who-did-what-when, newest-first. Filter ' +
        'by `events` (e.g. ["tenant.charged","tenant.refunded","tenant.plan_changed"]), `tenantId`, ' +
        'and a `since` ISO-8601 lower bound; `limit` caps the rows. This subsumes the per-event ' +
        'billing/lifecycle histories (charges, refunds, dunning, plan changes, credit grants, ' +
        'notifications, exports, usage alerts, …) via the `events` filter. Empty without an audit store.',
      inputSchema: {
        events: z.array(z.string()).optional(),
        tenantId: z.string().optional(),
        since: z.string().optional(),
        limit: z.number().int().min(1).optional(),
      },
    },
    async ({ events, tenantId, since, limit }) => {
      try {
        return json({
          events: await tf.queryAudit({
            ...(events ? { events } : {}),
            ...(tenantId ? { tenantId } : {}),
            ...(since ? { since } : {}),
            ...(limit ? { limit } : {}),
          }),
        });
      } catch (error) {
        return text(error instanceof Error ? error.message : 'invalid audit query');
      }
    },
  );

  server.registerTool(
    'tf_audit_anomalies',
    {
      description:
        'Scan the recent audit trail for anomalies (read-only): an overall error spike plus ' +
        'per-actor / per-tenant error clusters. Optional `since` (ISO-8601) and window `limit`. ' +
        'Detection only — no mutation.',
      inputSchema: { since: z.string().optional(), limit: z.number().int().min(1).optional() },
    },
    async ({ since, limit }) =>
      json({
        anomalies: await tf.scanAuditAnomalies({
          ...(since ? { since } : {}),
          ...(limit ? { limit } : {}),
        }),
      }),
  );

  server.registerTool(
    'tf_cost_anomalies',
    {
      description:
        'Scan the fleet for cost/margin anomalies over a period (read-only FinOps): unprofitable + ' +
        'unpriced tenants always, plus opt-in thin-margin (`minMarginUsd`) / high-cost (`maxCostUsd`). ' +
        'from/to are ISO-8601; default is the current calendar month.',
      inputSchema: {
        from: z.string().optional(),
        to: z.string().optional(),
        minMarginUsd: z.number().optional(),
        maxCostUsd: z.number().optional(),
      },
    },
    async ({ from, to, minMarginUsd, maxCostUsd }) => {
      const p = period(from, to);
      return p === null
        ? text('invalid from/to date (use ISO-8601)')
        : json({
            anomalies: await tf.scanCostAnomalies(p, {
              ...(minMarginUsd !== undefined ? { minMarginUsd } : {}),
              ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
            }),
          });
    },
  );

  server.registerTool(
    'tf_retention',
    {
      description:
        'Retention report (read-only): which archived (offboarding) tenants are scheduled for purge ' +
        'and when, given the retention window. Optional `retentionDays` override (default = ' +
        'configured). The preview of what the purge sweep would delete; eligibility matches it exactly.',
      inputSchema: { retentionDays: z.number().int().min(0).optional() },
    },
    async ({ retentionDays }) =>
      json(await tf.retentionReport(retentionDays !== undefined ? { retentionDays } : undefined)),
  );

  server.registerTool(
    'tf_plans',
    {
      description:
        "The operator's plan catalog (read-only): published tiers (id, name, price, included " +
        'allowances). Assigning a plan to a tenant is a billing-policy op kept off the agent surface.',
      inputSchema: {},
    },
    () => json({ plans: tf.listPlans() }),
  );

  server.registerTool(
    'tf_signup_tokens',
    {
      description:
        'Recent signup/invite tokens (read-only): status only — never the token or its hash. ' +
        'Issuing/redeeming (which provisions a tenant) is kept off the agent surface. ' +
        '`limit` caps the newest-first results.',
      inputSchema: { limit: z.number().int().min(1).optional() },
    },
    async ({ limit }) => json({ signupTokens: await tf.listSignupTokens(limit) }),
  );

  server.registerTool(
    'tf_credit_balance',
    {
      description:
        "A tenant's credit balance + ledger (read-only). `currency` defaults to usd. Granting/" +
        'consuming credit (money) is kept off the agent surface.',
      inputSchema: {
        id: z.string(),
        currency: z.string().optional(),
        limit: z.number().int().min(1).optional(),
      },
    },
    async ({ id, currency, limit }) =>
      json({
        tenantId: id,
        currency: (currency ?? 'usd').toLowerCase(),
        balanceMinor: await tf.creditBalance(id, currency),
        entries: await tf.creditHistory(id, limit),
      }),
  );

  return server;
}
