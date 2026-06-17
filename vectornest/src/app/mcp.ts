import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { vectorNestFromConfig } from './lib.js';
import { createMcpServer } from './mcp-server.js';

/** Entry point: wire VectorNest from config and serve it over MCP stdio. */
async function main(): Promise<void> {
  const vn = vectorNestFromConfig(loadConfig());
  const server = createMcpServer(vn);

  const shutdown = (): void => {
    void vn.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(
    `vectornest mcp: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
