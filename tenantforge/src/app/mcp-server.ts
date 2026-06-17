import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TENANTFORGE } from '../meta.js';
import type { JsonObject } from '../core/index.js';
import type { TenantForge } from './lib.js';

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

  server.registerTool(
    'tf_provision',
    {
      description:
        'Provision a tenant: create an isolated Neon project and record it. Idempotent on slug. ' +
        'The connection secret is issued to the secret store, not returned here.',
      inputSchema: {
        slug: z.string(),
        region: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ slug, region, metadata }) => {
      const outcome = await tf.provision({
        slug,
        ...(region ? { region } : {}),
        ...(metadata ? { metadata: metadata as JsonObject } : {}),
      });
      // Deliberately omit outcome.connectionUri (a secret) from the model-visible result.
      return json({
        tenant: outcome.tenant,
        connectionSecretIssued: outcome.connectionUri !== null,
      });
    },
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
      description: 'List tenants, most-recent first. Optional status filter and page size.',
      inputSchema: {
        status: z
          .enum(['provisioning', 'active', 'suspended', 'offboarding', 'deleted'])
          .optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      },
    },
    async ({ status, limit }) => {
      const tenants = await tf.listTenants({
        ...(status ? { status } : {}),
        ...(limit ? { limit } : {}),
      });
      return json({ tenants });
    },
  );

  server.registerTool(
    'tf_suspend',
    {
      description: 'Suspend an active tenant (reversible with tf_resume).',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => json({ tenant: await tf.suspend(id) }),
  );

  server.registerTool(
    'tf_resume',
    {
      description: 'Resume a suspended tenant back to active.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => json({ tenant: await tf.resume(id) }),
  );

  server.registerTool(
    'tf_offboard',
    {
      description:
        "DESTRUCTIVE + IRREVERSIBLE: export then delete a tenant's Neon project. Requires " +
        'confirm=true. Export runs first unless skipExport=true with a reason.',
      inputSchema: {
        id: z.string(),
        confirm: z.boolean().optional(),
        skipExport: z.boolean().optional(),
        reason: z.string().optional(),
      },
    },
    async ({ id, confirm, skipExport, reason }) => {
      // Excessive-agency guard: refuse the irreversible delete without explicit confirmation.
      if (confirm !== true) {
        return text(
          `refusing to offboard ${id}: this irreversibly deletes the tenant's database. ` +
            'Re-invoke with confirm=true to proceed.',
        );
      }
      const outcome = await tf.offboard(id, {
        ...(skipExport !== undefined ? { skipExport } : {}),
        ...(reason !== undefined ? { reason } : {}),
      });
      return json({ tenant: outcome.tenant, export: outcome.export });
    },
  );

  return server;
}
