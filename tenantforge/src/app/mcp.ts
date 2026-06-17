import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { tenantForgeFromConfig } from './lib.js';
import { createMcpServer } from './mcp-server.js';

/** Entry point: wire TenantForge from config and serve the control plane over MCP stdio. */
async function main(): Promise<void> {
  const tf = tenantForgeFromConfig(loadConfig());
  const server = createMcpServer(tf);

  const shutdown = (): void => {
    void tf.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(
    `tenantforge mcp: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
