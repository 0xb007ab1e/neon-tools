import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { VECTORNEST } from '../meta.js';
import type { VectorNest } from './lib.js';

/** Wrap a string as a tool text result. */
const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });

/**
 * Build the VectorNest MCP server, exposing the tool surface from neon-tool.json over MCP. The
 * {@link VectorNest} service is injected so the server can be constructed (and tested) without
 * connecting to live infrastructure.
 *
 * @param vn - The VectorNest application service the tools delegate to.
 * @returns A configured (not-yet-connected) MCP server.
 */
export function createMcpServer(vn: VectorNest): McpServer {
  const server = new McpServer({ name: VECTORNEST.id, version: VECTORNEST.version });

  server.registerTool(
    'vn_ingest',
    {
      description: 'Ingest documents from a file or directory path into a collection.',
      inputSchema: { source: z.string(), collection: z.string().optional() },
    },
    async ({ source, collection }) => {
      const s = await vn.ingest(source, { collection: collection ?? 'default' });
      return text(
        `ingested ${s.documents} document(s), ${s.chunks} chunk(s); skipped ${s.skipped}`,
      );
    },
  );

  server.registerTool(
    'vn_query',
    {
      description:
        'Semantic search over a collection; returns ranked chunks. mode: vector | keyword | hybrid.',
      inputSchema: {
        text: z.string(),
        collection: z.string().optional(),
        k: z.number().int().min(1).max(100).optional(),
        mode: z.enum(['vector', 'keyword', 'hybrid']).optional(),
      },
    },
    async ({ text: queryText, collection, k, mode }) => {
      const hits = await vn.query(queryText, {
        ...(collection ? { collection } : {}),
        ...(k ? { k } : {}),
        ...(mode ? { mode } : {}),
      });
      return text(JSON.stringify(hits, null, 2));
    },
  );

  server.registerTool(
    'vn_reembed',
    {
      description:
        'Re-embed the corpus under a model alongside the active one; optionally activate it (zero-downtime swap).',
      inputSchema: {
        model: z.string(),
        dim: z.number().int().positive().optional(),
        activate: z.boolean().optional(),
      },
    },
    async ({ model, dim, activate }) => {
      const s = await vn.reembed(model, { ...(dim ? { dim } : {}), activate: activate ?? false });
      return text(
        `re-embedded ${s.embedded}; coverage ${s.coverage}/${s.total}; ${s.activated ? 'ACTIVATED' : 'not activated'}`,
      );
    },
  );

  server.registerTool(
    'vn_eval',
    {
      description: 'Evaluate a model against a labeled query set (recall@k, MRR).',
      inputSchema: {
        model: z.string(),
        evalSet: z
          .array(z.object({ query: z.string(), relevant: z.array(z.string()).min(1) }))
          .min(1),
        k: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ model, evalSet, k }) => {
      const r = await vn.evaluate(model, evalSet, { ...(k ? { k } : {}) });
      return text(JSON.stringify(r.report, null, 2));
    },
  );

  server.registerTool(
    'vn_collections',
    { description: 'List collections.', inputSchema: {} },
    async () => {
      const cols = await vn.collections();
      return text(
        JSON.stringify(
          cols.map((c) => ({ id: c.id, name: c.name })),
          null,
          2,
        ),
      );
    },
  );

  return server;
}
