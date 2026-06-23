import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createPgRateLimitStore } from '../adapters/neon-pg/rate-limit-store.js';
import { createPgIdempotencyStore } from '../adapters/neon-pg/idempotency-store.js';
import { createOidcAuthenticator } from '../adapters/auth/oidc-authenticator.js';
import { createMetricsEventSink } from '../adapters/metrics-event-sink.js';
import { createWebhookEventSink } from '../adapters/webhook-event-sink.js';
import { createFanOutEventSink, createJsonEventSink } from '../adapters/event-sink.js';
import type { EventSink } from '../ports/event-sink.js';
import { loadConfig } from './config.js';
import { createHttpServer } from './http-server.js';
import { createTokenTenantAuthenticator } from '../adapters/auth/tenant-token-authenticator.js';
import { createOidcTenantAuthenticator } from '../adapters/auth/oidc-tenant-authenticator.js';
import { tenantForgeFromConfig } from './lib.js';

/** Read an ordered migration catalog from a directory of `*.sql` files (sorted by filename). */
function readMigrationCatalog(dir: string): { version: string; sql: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort()
    .map((f) => ({ version: f.replace(/\.sql$/, ''), sql: readFileSync(join(dir, f), 'utf8') }));
}

/** Entry point: serve the TenantForge HTTP control-plane API. Fails closed without a way to authenticate. */
function main(): void {
  const config = loadConfig();
  if (
    config.authMode === 'token' &&
    config.httpCredentials === undefined &&
    config.httpToken === undefined
  ) {
    process.stderr.write(
      'TENANTFORGE_HTTP_TOKEN or TENANTFORGE_HTTP_CREDENTIALS is required for token auth (or set TENANTFORGE_AUTH_MODE=oidc)\n',
    );
    process.exit(1);
  }

  // Derive RED metrics from the same event stream that feeds the JSON logs, and expose /metrics.
  // Optionally fan out lifecycle events to a signed outbound webhook (notify billing/CRM/alerting).
  const metrics = createMetricsEventSink();
  const sinks: EventSink[] = [createJsonEventSink(), metrics];
  if (config.webhook !== undefined) {
    sinks.push(
      createWebhookEventSink({
        url: config.webhook.url,
        secret: config.webhook.secret,
        ...(config.webhook.eventTypes !== undefined
          ? { eventTypes: config.webhook.eventTypes }
          : {}),
        onError: (event, error) =>
          process.stderr.write(`webhook delivery failed for ${event.event}: ${error}\n`),
      }),
    );
  }
  const tf = tenantForgeFromConfig(config, { eventSink: createFanOutEventSink(sinks) });
  // Shared (cross-instance) rate-limit counter when configured; else the in-memory default.
  const rateLimitStore =
    config.rateLimitStore === 'pg'
      ? createPgRateLimitStore({
          connectionString: config.databaseUrl,
          allowInsecure: config.allowInsecureDb,
        })
      : undefined;
  // Shared (cross-instance) idempotency store when configured; else the in-memory default.
  const idempotencyStore =
    config.idempotencyStore === 'pg'
      ? createPgIdempotencyStore({
          connectionString: config.databaseUrl,
          allowInsecure: config.allowInsecureDb,
        })
      : undefined;
  // OIDC mode: verify Bearer JWTs against the issuer's JWKS; else use the static-token authenticator
  // built by createHttpServer from the credentials / admin-token shorthand.
  const authenticator =
    config.oidc !== undefined
      ? createOidcAuthenticator({
          issuer: config.oidc.issuer,
          audience: config.oidc.audience,
          jwksUri: config.oidc.jwksUri,
          allowInsecure: config.allowInsecureUrls,
          subjectClaim: config.oidc.subjectClaim,
          roleClaim: config.oidc.roleClaim,
          ...(config.oidc.permissionsClaim !== undefined
            ? { permissionsClaim: config.oidc.permissionsClaim }
            : {}),
        })
      : undefined;
  // Portal tenant authenticator: OIDC (verify the customer IdP's JWT, tenant from a claim) when
  // configured, else the static token map; undefined ⇒ the portal isn't mounted.
  const tenantAuthenticator =
    config.portalOidc !== undefined
      ? createOidcTenantAuthenticator({
          issuer: config.portalOidc.issuer,
          audience: config.portalOidc.audience,
          jwksUri: config.portalOidc.jwksUri,
          tenantClaim: config.portalOidc.tenantClaim,
          allowInsecure: config.allowInsecureUrls,
        })
      : config.portalCredentials !== undefined
        ? createTokenTenantAuthenticator(config.portalCredentials)
        : undefined;
  const app = createHttpServer(tf, {
    ...(authenticator !== undefined ? { authenticator } : {}),
    ...(config.httpCredentials !== undefined ? { credentials: config.httpCredentials } : {}),
    ...(config.httpToken !== undefined ? { token: config.httpToken } : {}),
    rateLimit: config.rateLimit,
    ...(rateLimitStore !== undefined ? { rateLimitStore } : {}),
    ...(idempotencyStore !== undefined ? { idempotencyStore } : {}),
    ...(config.dashboardSecret !== undefined ? { dashboardSecret: config.dashboardSecret } : {}),
    ...(config.dashboardDist !== undefined ? { dashboardStaticRoot: config.dashboardDist } : {}),
    // Load the ordered SQL catalog so the dashboard can execute a reconcile (tenant:provision-gated).
    ...(config.migrationsDir !== undefined
      ? { dashboardReconcileCatalog: readMigrationCatalog(config.migrationsDir) }
      : {}),
    // Mount the inbound PSP webhook endpoint when a verifier is configured (signing secret set).
    ...(config.paymentWebhookSecret !== undefined ? { paymentWebhooks: true } : {}),
    // Mount the customer-facing self-serve portal when a session key + a tenant authenticator are
    // configured: OIDC (verify the customer IdP's JWT) when portalAuthMode=oidc, else the static
    // token map. Either way the portal derives the tenant only from the verified principal.
    ...(config.portalSecret !== undefined && tenantAuthenticator !== undefined
      ? { portalSecret: config.portalSecret, tenantAuthenticator }
      : {}),
    // Public self-serve signup — mounted when enabled (signup secret + the public Stripe/captcha keys).
    // Config validation guarantees these are present together when TENANTFORGE_SIGNUP_SECRET is set.
    ...(config.signupSecret !== undefined &&
    config.stripePublishableKey !== undefined &&
    config.captcha.siteKey !== undefined
      ? {
          signupSecret: config.signupSecret,
          signupPublishableKey: config.stripePublishableKey,
          signupCaptchaSiteKey: config.captcha.siteKey,
          ...(config.signupDist !== undefined ? { signupStaticRoot: config.signupDist } : {}),
        }
      : {}),
    metrics: () => metrics.render(),
  });

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    process.stderr.write(`tenantforge http listening on :${info.port}\n`);
  });

  const shutdown = (): void => {
    server.close();
    void Promise.allSettled([
      tf.close(),
      rateLimitStore?.close(),
      idempotencyStore?.close(),
    ]).finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
