import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createHttpServer } from './http-server.js';
import { tenantForgeFromConfig } from './lib.js';

/** Entry point: serve the TenantForge HTTP control-plane API. Fails closed without a bearer token. */
function main(): void {
  const config = loadConfig();
  if (config.httpCredentials === undefined && config.httpToken === undefined) {
    process.stderr.write(
      'TENANTFORGE_HTTP_TOKEN or TENANTFORGE_HTTP_CREDENTIALS is required to run the HTTP server\n',
    );
    process.exit(1);
  }

  const tf = tenantForgeFromConfig(config);
  const app = createHttpServer(tf, {
    ...(config.httpCredentials !== undefined ? { credentials: config.httpCredentials } : {}),
    ...(config.httpToken !== undefined ? { token: config.httpToken } : {}),
    rateLimit: config.rateLimit,
  });

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    process.stderr.write(`tenantforge http listening on :${info.port}\n`);
  });

  const shutdown = (): void => {
    server.close();
    void tf.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
