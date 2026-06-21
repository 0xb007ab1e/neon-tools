import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createMcpServer } from '../../src/app/mcp-server.js';
import { decodeCursor } from '../../src/core/index.js';
import { currentActor } from '../../src/app/actor-context.js';
import type { TenantRecord } from '../../src/core/domain.js';
import type { TenantForge } from '../../src/app/lib.js';

/** Build a fake TenantForge with only the methods a given test exercises. */
const fakeTf = (overrides: Partial<TenantForge>): TenantForge =>
  overrides as unknown as TenantForge;

/** Connect an in-memory client to a server wrapping the given fake. */
async function connect(tf: TenantForge): Promise<Client> {
  const server = createMcpServer(tf);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const tenant: TenantRecord = {
  id: 't1',
  slug: 'acme',
  region: 'aws-us-east-1',
  status: 'active',
  neonProjectId: 'proj-1',
  metadata: {},
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

// The concatenated text of a tool result's content blocks (the real JSON/message, not re-stringified).
const body = (result: unknown) =>
  (result as { content: { text: string }[] }).content.map((c) => c.text).join('\n');

describe('MCP server', () => {
  it('exposes the documented tool surface', async () => {
    const client = await connect(fakeTf({}));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'tf_compliance_report',
      'tf_cost_report',
      'tf_invoice',
      'tf_invoices',
      'tf_list_tenants',
      'tf_offboard',
      'tf_provision',
      'tf_reconcile_history',
      'tf_reconcile_plan',
      'tf_resume',
      'tf_suspend',
      'tf_tenant',
    ]);
    // Mutating/SQL-bearing fleet ops + purge are intentionally NOT on the agent surface (LLM08).
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('tf_purge');
    expect(names).not.toContain('tf_reconcile'); // execution; only the read-only plan is exposed
    await client.close();
  });

  it('tf_provision returns the tenant WITHOUT the connection secret', async () => {
    const client = await connect(
      fakeTf({
        provision: async () => ({ tenant, connectionUri: 'postgresql://secret@host/db' }),
      }),
    );
    const result = await client.callTool({ name: 'tf_provision', arguments: { slug: 'acme' } });
    const out = body(result);
    expect(out).toContain('"connectionSecretIssued": true');
    expect(out).not.toContain('postgresql://secret@host/db'); // secret never enters model context
    await client.close();
  });

  it('tf_tenant reports not found', async () => {
    const client = await connect(fakeTf({ getTenant: async () => null }));
    const result = await client.callTool({ name: 'tf_tenant', arguments: { id: 'nope' } });
    expect(body(result)).toContain('not found');
    await client.close();
  });

  it('tf_list_tenants returns tenants', async () => {
    const client = await connect(fakeTf({ listTenants: async () => [tenant] }));
    const result = await client.callTool({ name: 'tf_list_tenants', arguments: {} });
    expect(body(result)).toContain('acme');
    await client.close();
  });

  it('tf_list_tenants emits a keyset nextCursor on a full page and forwards it', async () => {
    const calls: Array<{ cursor?: { createdAt: Date; id: string } }> = [];
    const client = await connect(
      fakeTf({
        listTenants: async (options) => {
          calls.push(options ?? {});
          return [tenant];
        },
      }),
    );
    // limit=1 and one row → full page → a next-page cursor is returned.
    const first = await client.callTool({ name: 'tf_list_tenants', arguments: { limit: 1 } });
    const { nextCursor } = JSON.parse(body(first)) as { nextCursor: string | null };
    expect(nextCursor).not.toBeNull();
    expect(decodeCursor(nextCursor!)).toEqual({ createdAt: tenant.createdAt, id: tenant.id });

    // The token round-trips back in as a keyset cursor.
    await client.callTool({
      name: 'tf_list_tenants',
      arguments: { limit: 1, cursor: nextCursor! },
    });
    expect(calls[1]!.cursor).toEqual({ createdAt: tenant.createdAt, id: tenant.id });
    await client.close();
  });

  it('tf_list_tenants reports an invalid cursor without calling the service', async () => {
    let called = false;
    const client = await connect(
      fakeTf({
        listTenants: async () => {
          called = true;
          return [];
        },
      }),
    );
    const result = await client.callTool({
      name: 'tf_list_tenants',
      arguments: { cursor: 'not-a-valid-cursor' },
    });
    expect(body(result)).toContain('invalid cursor');
    expect(called).toBe(false);
    await client.close();
  });

  it('attributes a mutating tool call to the mcp operator (audit context)', async () => {
    let seen: unknown = 'unset';
    const client = await connect(
      fakeTf({
        suspend: async () => {
          seen = currentActor();
          return tenant;
        },
      }),
    );
    await client.callTool({ name: 'tf_suspend', arguments: { id: 't1' } });
    expect(seen).toEqual({ id: 'mcp', role: 'admin' });
    await client.close();
  });

  it('tf_offboard archives (reversible) and returns the archive ref — no hard-delete via MCP', async () => {
    const client = await connect(
      fakeTf({
        offboard: async () => ({
          tenant: { ...tenant, status: 'offboarding' },
          archive: { location: 'neon-project:proj-1' },
        }),
      }),
    );
    const result = await client.callTool({ name: 'tf_offboard', arguments: { id: 't1' } });
    const out = body(result);
    expect(out).toContain('"status": "offboarding"');
    expect(out).toContain('neon-project:proj-1');
    await client.close();
  });

  it('does not expose an irreversible purge tool to agents (LLM08)', async () => {
    const client = await connect(fakeTf({}));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('tf_purge');
    await client.close();
  });

  it('tf_compliance_report returns the report + digest', async () => {
    const report = { report: { inventory: { total: 2 } }, digest: 'abc123' };
    const client = await connect(fakeTf({ complianceReport: async () => report as never }));
    const out = body(await client.callTool({ name: 'tf_compliance_report', arguments: {} }));
    expect(out).toContain('"digest": "abc123"');
    await client.close();
  });

  it('tf_cost_report passes the period through and returns the report', async () => {
    let seen: { from: Date; to: Date } | undefined;
    const cost = { generatedAt: 'x', rows: [], unmetered: [], totals: { tenants: 0 } };
    const client = await connect(
      fakeTf({
        costReport: async (p) => {
          seen = p;
          return cost as never;
        },
      }),
    );
    const out = body(
      await client.callTool({
        name: 'tf_cost_report',
        arguments: { from: '2026-06-01T00:00:00.000Z', to: '2026-06-30T00:00:00.000Z' },
      }),
    );
    expect(out).toContain('"generatedAt": "x"');
    expect(seen?.from.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    await client.close();
  });

  it('tf_cost_report rejects a bad date (fail closed, no service call)', async () => {
    let called = false;
    const client = await connect(
      fakeTf({
        costReport: async () => {
          called = true;
          return {} as never;
        },
      }),
    );
    const out = body(
      await client.callTool({ name: 'tf_cost_report', arguments: { from: 'not-a-date' } }),
    );
    expect(out).toContain('invalid from/to date');
    expect(called).toBe(false);
    await client.close();
  });

  it('tf_reconcile_plan is read-only and forwards the target; history reads the trail', async () => {
    let target: string | undefined;
    const plan = {
      target: '0003',
      perTenant: [],
      pendingTenants: [],
      upToDate: [],
      totalMissing: 0,
    };
    const client = await connect(
      fakeTf({
        reconcilePlan: async (o) => {
          target = o?.targetVersion;
          return plan as never;
        },
        reconcileHistory: async () =>
          [{ event: 'fleet.reconcile', at: 'x', outcome: 'ok' }] as never,
      }),
    );
    const planOut = body(
      await client.callTool({ name: 'tf_reconcile_plan', arguments: { target: '0003' } }),
    );
    expect(planOut).toContain('"target": "0003"');
    expect(target).toBe('0003');
    const histOut = body(await client.callTool({ name: 'tf_reconcile_history', arguments: {} }));
    expect(histOut).toContain('fleet.reconcile');
    await client.close();
  });
});
