import { assertRoutable } from '../core/index.js';
import type { ConnectionRouter, TenantConnection } from '../ports/connection-router.js';
import type { SecretStore } from '../ports/secret-store.js';
import type { TenantRegistry } from '../ports/tenant-registry.js';
import type { EventSink } from '../ports/event-sink.js';
import { createNoopEventSink } from './event-sink.js';

/** Bounded reason for a `connection.resolve` outcome (low-cardinality metric context; no free text). */
type ResolveReason = 'ok' | 'not_found' | 'not_routable' | 'no_secret';

/** Collaborators for {@link createConnectionRouter}. */
export interface ConnectionRouterDeps {
  /** Source of tenant records (status drives routability). */
  registry: TenantRegistry;
  /** Source of the per-tenant connection secret (keyed by tenant id). */
  secretStore: SecretStore;
  /**
   * Sink for the connection-resolution SLI (M4). One `connection.resolve` {@link EventSink} event is
   * emitted per resolve; `outcome:'error'` marks a denial, with a bounded `reason` — so
   * `tenantforge_events_total{event="connection.resolve",outcome}` gives the denial rate the deploy
   * runbook watches. Defaults to a no-op. Never carries a secret or free-text.
   */
  eventSink?: EventSink;
}

/**
 * Create a {@link ConnectionRouter} that resolves a tenant id to its connection, scoped to that
 * tenant's project.
 *
 * Fails closed at every step: the tenant must exist, be **routable** (active + provisioned — see
 * {@link assertRoutable}), and have a stored connection secret. The tenant id must be derived
 * server-side by the caller, never from client input (BOLA — std-owasp-api / topic-multi-tenancy).
 * The resolved URI is a secret and is never logged.
 *
 * @param deps - The registry and secret store.
 * @returns A connection router.
 */
export function createConnectionRouter(deps: ConnectionRouterDeps): ConnectionRouter {
  const { registry, secretStore } = deps;
  const eventSink = deps.eventSink ?? createNoopEventSink();

  /**
   * Emit the resolution SLI event, then perform the terminal action (return on success / throw on
   * denial). Emitting BEFORE re-throwing keeps caller behavior unchanged while making the denial
   * observable. `reason` is a bounded enum — never a secret or free text.
   */
  const emit = (tenantId: string, reason: ResolveReason, startedAt: number): void => {
    eventSink.emit({
      event: 'connection.resolve',
      at: new Date().toISOString(),
      outcome: reason === 'ok' ? 'ok' : 'error',
      tenantId,
      durationMs: Date.now() - startedAt,
      context: { reason },
    });
  };

  return {
    async resolve(tenantId: string): Promise<TenantConnection> {
      const startedAt = Date.now();
      const tenant = await registry.getById(tenantId);
      if (!tenant) {
        emit(tenantId, 'not_found', startedAt);
        throw new Error(`tenant ${tenantId} not found`);
      }
      try {
        assertRoutable(tenant); // throws (fail closed) for non-active / unprovisioned tenants
      } catch (error) {
        emit(tenant.id, 'not_routable', startedAt);
        throw error;
      }
      const connectionUri = await secretStore.get(tenant.id);
      if (connectionUri === null) {
        emit(tenant.id, 'no_secret', startedAt);
        throw new Error(`tenant ${tenantId} has no stored connection secret`);
      }
      emit(tenant.id, 'ok', startedAt);
      return { tenantId: tenant.id, connectionUri };
    },
  };
}
