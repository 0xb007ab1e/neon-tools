import { describe, expect, it } from 'vitest';
import { currentActor, runWithActor } from '../../src/app/actor-context.js';

describe('actor context', () => {
  it('exposes the actor inside the scope and nothing outside it', () => {
    expect(currentActor()).toBeUndefined();
    const seen = runWithActor({ id: 'op-1', role: 'admin' }, () => currentActor());
    expect(seen).toEqual({ id: 'op-1', role: 'admin' });
    expect(currentActor()).toBeUndefined(); // scope did not leak
  });

  it('propagates the actor across awaits within the async scope', async () => {
    const seen = await runWithActor({ id: 'op-2', role: 'readonly' }, async () => {
      await Promise.resolve();
      return currentActor();
    });
    expect(seen).toEqual({ id: 'op-2', role: 'readonly' });
  });

  it('nested scopes shadow the outer actor', () => {
    const result = runWithActor({ id: 'outer', role: 'admin' }, () => {
      const inner = runWithActor({ id: 'inner', role: 'readonly' }, () => currentActor());
      return { inner, afterInner: currentActor() };
    });
    expect(result.inner).toEqual({ id: 'inner', role: 'readonly' });
    expect(result.afterInner).toEqual({ id: 'outer', role: 'admin' });
  });
});
