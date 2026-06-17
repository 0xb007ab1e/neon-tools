import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createHttpServer } from './http-server.js';
import { vectorNestFromConfig } from './lib.js';

/** Entry point: serve the VectorNest HTTP API. Fails closed without a bearer token. */
function main(): void {
  const config = loadConfig();
  if (!config.httpToken) {
    process.stderr.write('VECTORNEST_HTTP_TOKEN is required to run the HTTP server\n');
    process.exit(1);
  }

  const vn = vectorNestFromConfig(config);
  const app = createHttpServer(vn, { token: config.httpToken });

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    process.stderr.write(`vectornest http listening on :${info.port}\n`);
  });

  const shutdown = (): void => {
    server.close();
    void vn.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
