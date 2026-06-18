import { type TenantEvent } from '../core/observability.js';
import type { ProvisioningProvider } from '../ports/provisioning-provider.js';
import type { SecretStore } from '../ports/secret-store.js';
import type { TenantRegistry } from '../ports/tenant-registry.js';

/** Collaborators for {@link createSecretRotationEngine}. */
export interface SecretRotationEngineDeps {
  /** Tenant registry (read the record; list active tenants for a sweep). */
  registry: TenantRegistry;
  /** Provisioning provider (rotate the tenant project's credential). */
  provisioning: ProvisioningProvider;
  /** Secret store (store the new connection URI). */
  secretStore: SecretStore;
  /** Called after a tenant's secret rotates (e.g. to invalidate a cached connection). */
  onRotated?: (tenantId: string) => void;
  /** Optional audit sink. */
  emit?: (event: TenantEvent) => void;
  /** Injectable clock. Defaults to `() => new Date()`. */
  now?: () => Date;
}

/** The outcome of rotating one tenant's secret. */
export interface RotationResult {
  /** The tenant id. */
  tenantId: string;
  /** Whether the credential was rotated. */
  rotated: boolean;
}

/** The result of a fleet rotation sweep. */
export interface RotationSweepReport {
  /** Active tenants examined. */
  scanned: number;
  /** Tenant ids rotated this sweep. */
  rotated: string[];
  /** Tenants that failed (isolated — they don't block the sweep). */
  failed: { tenantId: string; error: string }[];
}

/** Upper bound on tenants scanned per rotation sweep. */
const MAX_SWEEP = 100_000;

/** Rotates per-tenant connection credentials (#7). */
export interface SecretRotationEngine {
  /**
   * Rotate one active tenant's connection credential: mint a new one on its Neon project, store it,
   * and invalidate any cached connection. Fail closed (the tenant must be active + provisioned).
   *
   * @param tenantId - The tenant to rotate.
   * @returns The rotation result.
   */
  rotate(tenantId: string): Promise<RotationResult>;

  /**
   * Rotate every **active** tenant's credential — the scheduled fleet sweep (cron / K8s CronJob).
   * Failure-isolated: one tenant's failure is reported, not fatal.
   *
   * @param options - Optional scan cap.
   * @returns Per-tenant sweep report.
   */
  rotateAll(options?: { limit?: number }): Promise<RotationSweepReport>;
}

/**
 * Create a {@link SecretRotationEngine} that automates per-tenant connection-credential rotation
 * (workflow-secrets, the secret-rotation runbook) — previously a manual procedure. Rotating mints a
 * new credential on the tenant's Neon project, stores it in the SecretStore, invalidates any cached
 * connection, and emits a `tenant.secret_rotated` audit event. The old/new URIs are secrets and are
 * never logged. Run `rotate` on demand or `rotateAll` on a schedule.
 *
 * @param deps - Registry, provisioning, secret store, and optional invalidation hook / audit / clock.
 * @returns A secret-rotation engine.
 */
export function createSecretRotationEngine(deps: SecretRotationEngineDeps): SecretRotationEngine {
  const now = deps.now ?? ((): Date => new Date());

  const rotate = async (tenantId: string): Promise<RotationResult> => {
    const tenant = await deps.registry.getById(tenantId);
    if (tenant === null) throw new Error(`rotateSecret: tenant not found: ${tenantId}`);
    if (tenant.status !== 'active' || tenant.neonProjectId === null) {
      throw new Error(`rotateSecret: tenant ${tenantId} must be active and provisioned`);
    }
    const { connectionUri } = await deps.provisioning.rotateTenantCredential(tenant.neonProjectId);
    await deps.secretStore.set(tenantId, connectionUri);
    deps.onRotated?.(tenantId);
    deps.emit?.({
      event: 'tenant.secret_rotated',
      at: now().toISOString(),
      outcome: 'ok',
      tenantId,
    });
    return { tenantId, rotated: true };
  };

  return {
    rotate,

    async rotateAll(options: { limit?: number } = {}): Promise<RotationSweepReport> {
      const active = await deps.registry.list({
        status: 'active',
        limit: options.limit ?? MAX_SWEEP,
      });
      const rotated: string[] = [];
      const failed: { tenantId: string; error: string }[] = [];
      for (const tenant of active) {
        try {
          await rotate(tenant.id);
          rotated.push(tenant.id);
        } catch (error) {
          failed.push({
            tenantId: tenant.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      deps.emit?.({
        event: 'tenant.secret_rotation_sweep',
        at: now().toISOString(),
        outcome: failed.length > 0 ? 'error' : 'ok',
        context: { scanned: active.length, rotated: rotated.length, failed: failed.length },
      });
      return { scanned: active.length, rotated, failed };
    },
  };
}
