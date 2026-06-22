// Contract test for the MCP agent surface (master §4: contract tests for every public API). An
// MCP tool's advertised `inputSchema` + `description` ARE the contract a calling agent depends on
// to invoke it correctly. This asserts every tool ships a documented, well-formed object schema —
// catching a malformed zod→JSON-Schema conversion or an undocumented tool before an agent hits it.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { createMcpServer } from '../../src/app/mcp-server.js';
import type { TenantForge } from '../../src/app/lib.js';

const fakeTf = (overrides: Partial<TenantForge>): TenantForge =>
  overrides as unknown as TenantForge;

// Lenient: tool schemas come from the SDK's zod→JSON-Schema conversion; we check they *compile*
// (are structurally valid), not that they match a particular meta-schema draft.
const ajv = new Ajv2020({ strict: false, validateSchema: false, logger: false });

async function listTools() {
  const server = createMcpServer(fakeTf({}));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'contract', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

describe('MCP tool-schema contract', () => {
  it('every advertised tool has a description and a compilable object input schema', async () => {
    const tools = await listTools();
    expect(tools.length).toBeGreaterThan(0);

    for (const tool of tools) {
      expect(tool.description?.trim(), `${tool.name} is missing a description`).toBeTruthy();
      expect(tool.inputSchema.type, `${tool.name} inputSchema is not an object`).toBe('object');
      // A malformed schema throws here — failing the contract for that tool.
      expect(
        () => ajv.compile(tool.inputSchema),
        `${tool.name} inputSchema does not compile`,
      ).not.toThrow();
    }
  });
});
