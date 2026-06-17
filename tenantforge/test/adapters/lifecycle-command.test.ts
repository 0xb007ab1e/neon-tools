import { describe, expect, it } from 'vitest';
import { parseLifecycleCommand } from '../../src/adapters/lifecycle-command.js';

describe('parseLifecycleCommand', () => {
  it('parses each command type', () => {
    expect(
      parseLifecycleCommand({ id: '1', type: 'provision', slug: 'acme', residency: 'eu' }),
    ).toMatchObject({
      type: 'provision',
      slug: 'acme',
      residency: 'eu',
    });
    expect(parseLifecycleCommand({ id: '2', type: 'suspend', tenantId: 't1' })).toMatchObject({
      type: 'suspend',
      tenantId: 't1',
    });
    expect(parseLifecycleCommand({ id: '3', type: 'resume', tenantId: 't1' }).type).toBe('resume');
    expect(parseLifecycleCommand({ id: '4', type: 'offboard', tenantId: 't1' }).type).toBe(
      'offboard',
    );
  });

  it('rejects unknown / malformed commands', () => {
    expect(() => parseLifecycleCommand({ id: '1', type: 'purge', tenantId: 't1' })).toThrow(); // purge not a queue command
    expect(() => parseLifecycleCommand({ type: 'suspend', tenantId: 't1' })).toThrow(); // missing id
    expect(() => parseLifecycleCommand({ id: '1', type: 'provision' })).toThrow(); // missing slug
    expect(() => parseLifecycleCommand('nope')).toThrow();
  });
});
