import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createMcpServer } from '../../src/app/mcp-server.js';
import type { VectorNest } from '../../src/app/lib.js';

/** Build a fake VectorNest with only the methods a given test exercises. */
const fakeVn = (overrides: Partial<VectorNest>): VectorNest => overrides as unknown as VectorNest;

/** Connect an in-memory client to a server wrapping the given fake. */
async function connect(vn: VectorNest): Promise<Client> {
  const server = createMcpServer(vn);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('MCP server', () => {
  it('exposes the documented tool surface', async () => {
    const client = await connect(fakeVn({}));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'vn_collections',
      'vn_eval',
      'vn_ingest',
      'vn_query',
      'vn_reembed',
    ]);
    await client.close();
  });

  it('vn_query returns ranked hits as text', async () => {
    const client = await connect(
      fakeVn({
        query: async () => [
          {
            chunkId: 'c1',
            documentId: 'd1',
            sourceUri: '/docs/neon.md',
            ordinal: 0,
            text: 'Neon scales to zero',
            score: 0.91,
            metadata: {},
          },
        ],
      }),
    );
    const result = await client.callTool({ name: 'vn_query', arguments: { text: 'idle cost?' } });
    expect(JSON.stringify(result.content)).toContain('/docs/neon.md');
    await client.close();
  });

  it('vn_collections lists collection names', async () => {
    const client = await connect(
      fakeVn({ collections: async () => [{ id: 'col1', name: 'default', metadata: {} }] }),
    );
    const result = await client.callTool({ name: 'vn_collections', arguments: {} });
    expect(JSON.stringify(result.content)).toContain('default');
    await client.close();
  });
});
