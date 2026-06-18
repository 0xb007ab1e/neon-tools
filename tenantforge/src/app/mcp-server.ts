import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TENANTFORGE } from '../meta.js';
import type { JsonObject } from '../core/index.js';
import { decodeCursor, encodeCursor } from '../core/index.js';
import type { TenantForge } from './lib.js';
import { runWithActor } from './actor-context.js';

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
 * connection secret into the model context (LLM06 sensitive-information disclosure), and the
 * irreversible `tf_offboard` requires an explicit `confirm` flag (LLM08 excessive agency).
 *
 * @param tf - The TenantForge application service the tools delegate to.
 * @returns A configured (not-yet-connected) MCP server.
 */
export function createMcpServer(tf: TenantForge): McpServer {
  const server = new McpServer({ name: TENANTFORGE.id, version: TENANTFORGE.version });

  // Attribute control-plane actions taken via the agent surface to a single `mcp` operator in
  // the audit stream (the MCP transport carries no per-call principal). Wrap emitting ops.
  const asMcp = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithActor({ id: 'mcp', role: 'admin' }, fn);

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
        'REVERSIBLE via tf_resume until purged. The irreversible hard-delete (purge) is intentionally ' +
        'not exposed to agents; run it via the CLI/HTTP control plane.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) =>
      asMcp(async () => {
        const outcome = await tf.offboard(id);
        return json({ tenant: outcome.tenant, archive: outcome.archive });
      }),
  );

  return server;
}
