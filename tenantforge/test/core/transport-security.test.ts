import { describe, expect, it } from 'vitest';
import { assertHttpsUrl, assertPostgresTls } from '../../src/core/transport-security.js';

describe('assertHttpsUrl', () => {
  it('accepts an https URL', () => {
    expect(() => assertHttpsUrl('https://vault.example.com:8200', 'VAULT_ADDR')).not.toThrow();
  });

  it('rejects an http (plaintext) URL, fail closed', () => {
    expect(() => assertHttpsUrl('http://vault.example.com', 'VAULT_ADDR')).toThrow(
      /VAULT_ADDR must use TLS/,
    );
  });

  it('rejects a non-http(s) scheme', () => {
    expect(() => assertHttpsUrl('ftp://host/x', 'X')).toThrow(/must use TLS/);
  });

  it('rejects a malformed URL', () => {
    expect(() => assertHttpsUrl('not a url', 'X')).toThrow(/is not a valid URL/);
  });

  it('permits a non-https URL only when allowInsecure is set (documented escape hatch)', () => {
    expect(() => assertHttpsUrl('http://localhost:8200', 'VAULT_ADDR', true)).not.toThrow();
  });
});

describe('assertPostgresTls', () => {
  it('accepts sslmode=require', () => {
    expect(() =>
      assertPostgresTls('postgres://u:p@host/db?sslmode=require', 'DATABASE_URL'),
    ).not.toThrow();
  });

  it('accepts the stronger verify-ca / verify-full (case-insensitive)', () => {
    expect(() =>
      assertPostgresTls('postgresql://h/db?sslmode=verify-full', 'DATABASE_URL'),
    ).not.toThrow();
    expect(() =>
      assertPostgresTls('postgres://h/db?foo=1&sslmode=VERIFY-CA', 'DATABASE_URL'),
    ).not.toThrow();
  });

  it('rejects a connection string with no sslmode (fail closed)', () => {
    expect(() => assertPostgresTls('postgres://u:p@host/db', 'DATABASE_URL')).toThrow(
      /must enforce TLS/,
    );
  });

  it('rejects the weaker, plaintext-capable modes', () => {
    for (const mode of ['disable', 'allow', 'prefer']) {
      expect(() => assertPostgresTls(`postgres://h/db?sslmode=${mode}`, 'DATABASE_URL')).toThrow(
        /must enforce TLS/,
      );
    }
  });

  it('permits a non-TLS connection only when allowInsecure is set (local-dev escape hatch)', () => {
    expect(() => assertPostgresTls('postgres://localhost/db', 'DATABASE_URL', true)).not.toThrow();
  });
});
