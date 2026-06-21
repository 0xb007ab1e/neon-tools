import { describe, expect, it } from 'vitest';
import { createPgTenantRegistry } from '../../src/adapters/neon-pg/registry.js';
import { createNeonPgSecretStore } from '../../src/adapters/neon-pg/secret-store.js';
import { createPgMessageQueue } from '../../src/adapters/neon-pg/message-queue.js';
import { createPgRateLimitStore } from '../../src/adapters/neon-pg/rate-limit-store.js';
import { createPgIdempotencyStore } from '../../src/adapters/neon-pg/idempotency-store.js';
import { createPgAuditLogStore } from '../../src/adapters/neon-pg/audit-log-store.js';
import { createVaultSecretStore } from '../../src/adapters/vault/secret-store.js';
import { createAzureKeyVaultStore } from '../../src/adapters/azure-key-vault/secret-store.js';
import { createStripeGateway } from '../../src/adapters/payment/stripe-gateway.js';
import { createOidcAuthenticator } from '../../src/adapters/auth/oidc-authenticator.js';

const PLAIN_PG = 'postgres://u:p@localhost:5432/db';
const TLS_PG = 'postgres://u:p@host/db?sslmode=require';

describe('Postgres adapters fail closed without TLS (sslmode=require)', () => {
  it('the registry refuses a plaintext connection string', () => {
    expect(() => createPgTenantRegistry({ connectionString: PLAIN_PG })).toThrow(/enforce TLS/);
  });

  it('the encrypted secret store refuses a plaintext connection string', () => {
    expect(() =>
      createNeonPgSecretStore({ connectionString: PLAIN_PG, key: Buffer.alloc(32) }),
    ).toThrow(/enforce TLS/);
  });

  it('the message queue, rate-limit, idempotency, and audit stores all refuse plaintext', () => {
    expect(() => createPgMessageQueue({ connectionString: PLAIN_PG })).toThrow(/enforce TLS/);
    expect(() => createPgRateLimitStore({ connectionString: PLAIN_PG })).toThrow(/enforce TLS/);
    expect(() => createPgIdempotencyStore({ connectionString: PLAIN_PG })).toThrow(/enforce TLS/);
    expect(() => createPgAuditLogStore({ connectionString: PLAIN_PG })).toThrow(/enforce TLS/);
  });

  it('accepts a TLS connection string, and a plaintext one with the explicit opt-out', async () => {
    const ok = createPgTenantRegistry({ connectionString: TLS_PG });
    await ok.close();
    const optOut = createPgTenantRegistry({ connectionString: PLAIN_PG, allowInsecure: true });
    await optOut.close();
  });
});

describe('HTTPS-URL adapters fail closed without TLS', () => {
  it('Vault refuses a non-https address', () => {
    expect(() =>
      createVaultSecretStore({ address: 'http://vault.local:8200', token: 't' }),
    ).toThrow(/must use TLS/);
  });

  it('Azure Key Vault refuses a non-https URL', () => {
    expect(() =>
      createAzureKeyVaultStore({
        vaultUrl: 'http://kv.local',
        getToken: () => Promise.resolve('t'),
      }),
    ).toThrow(/must use TLS/);
  });

  it('the Stripe gateway refuses a non-https base URL override', () => {
    expect(() => createStripeGateway({ secretKey: 'sk', baseUrl: 'http://stripe.local' })).toThrow(
      /must use TLS/,
    );
  });

  it('the OIDC authenticator refuses a non-https JWKS URI', () => {
    expect(() =>
      createOidcAuthenticator({
        issuer: 'https://issuer',
        audience: 'aud',
        jwksUri: 'http://issuer/jwks',
      }),
    ).toThrow(/must use TLS/);
  });

  it('all accept their secure forms (and honor the explicit opt-out)', () => {
    expect(() =>
      createVaultSecretStore({ address: 'https://vault.local:8200', token: 't' }),
    ).not.toThrow();
    expect(() => createStripeGateway({ secretKey: 'sk' })).not.toThrow(); // default is https
    expect(() =>
      createStripeGateway({ secretKey: 'sk', baseUrl: 'http://mock.local', allowInsecure: true }),
    ).not.toThrow();
  });
});
