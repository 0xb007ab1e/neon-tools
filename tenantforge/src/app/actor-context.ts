import { AsyncLocalStorage } from 'node:async_hooks';

/** The operator performing a control-plane action (for audit attribution). */
export interface Actor {
  /** Operator identity (HTTP principal id, `cli:<user>`, or `mcp`). Never a secret. */
  id: string;
  /** The operator's role at the time of the action. */
  role: string;
}

/**
 * Request-scoped audit context. Like a correlation id, the entrypoint (HTTP middleware / CLI
 * command / MCP tool) records *who* is acting once at the boundary, and the facade's event
 * emitter reads it — so no operation needs an explicit actor parameter. Degrades to no
 * attribution (no actor on the event) when run outside any context, e.g. a cron sweep.
 */
const storage = new AsyncLocalStorage<Actor>();

/**
 * Run `fn` with `actor` as the ambient operator for the duration of the (async) call. Nested
 * calls shadow the outer actor for their own scope.
 *
 * @param actor - The operator to attribute actions to.
 * @param fn - The operation to run within the context.
 * @returns Whatever `fn` returns.
 */
export function runWithActor<T>(actor: Actor, fn: () => T): T {
  return storage.run(actor, fn);
}

/**
 * The operator in scope for the current async context, or `undefined` outside any
 * {@link runWithActor} call.
 *
 * @returns The current {@link Actor}, or `undefined`.
 */
export function currentActor(): Actor | undefined {
  return storage.getStore();
}
