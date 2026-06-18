import { serve } from '@hono/node-server';
import { createPgRateLimitStore } from '../adapters/neon-pg/rate-limit-store.js';
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
  // Shared (cross-instance) rate-limit counter when configured; else the in-memory default.
  const rateLimitStore =
    config.rateLimitStore === 'pg'
      ? createPgRateLimitStore({ connectionString: config.databaseUrl })
      : undefined;
  const app = createHttpServer(tf, {
    ...(config.httpCredentials !== undefined ? { credentials: config.httpCredentials } : {}),
    ...(config.httpToken !== undefined ? { token: config.httpToken } : {}),
    rateLimit: config.rateLimit,
    ...(rateLimitStore !== undefined ? { rateLimitStore } : {}),
  });

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    process.stderr.write(`tenantforge http listening on :${info.port}\n`);
  });

  const shutdown = (): void => {
    server.close();
    void Promise.allSettled([tf.close(), rateLimitStore?.close()]).finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
