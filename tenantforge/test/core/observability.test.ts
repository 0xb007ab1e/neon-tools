import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../../src/core/observability.js';

describe('redactSecrets', () => {
  it('masks secret-keyed values, preserves the rest', () => {
    expect(
      redactSecrets({
        slug: 'acme',
        connectionUri: 'postgresql://u:p@h/db',
        region: 'aws-us-east-1',
      }),
    ).toEqual({ slug: 'acme', connectionUri: '[redacted]', region: 'aws-us-east-1' });
  });

  it('matches secret keys case-insensitively and by substring', () => {
    const out = redactSecrets({ NEON_API_KEY: 'k', dbPassword: 'p', authToken: 't', count: 3 });
    expect(out).toEqual({
      NEON_API_KEY: '[redacted]',
      dbPassword: '[redacted]',
      authToken: '[redacted]',
      count: 3,
    });
  });

  it('recurses into nested objects and arrays', () => {
    const out = redactSecrets({
      tenant: { id: 't1', secret: 's' },
      conns: [{ host: 'h', password: 'p' }],
    });
    expect(out).toEqual({
      tenant: { id: 't1', secret: '[redacted]' },
      conns: [{ host: 'h', password: '[redacted]' }],
    });
  });

  it('leaves a secret-free object unchanged', () => {
    const input = { slug: 'acme', from: 'active', to: 'suspended', n: 1, ok: true, nil: null };
    expect(redactSecrets(input)).toEqual(input);
  });
});
