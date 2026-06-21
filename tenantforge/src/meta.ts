/**
 * Static build metadata for the TenantForge tool.
 *
 * Kept dependency-free so any entrypoint (library / CLI / MCP / HTTP) can report
 * identity without pulling in adapters or I/O.
 */
export const TENANTFORGE = {
  /** Stable tool id; matches `id` in neon-tool.json. */
  id: 'tenantforge',
  /** Semantic version of this build. */
  version: '0.7.0',
} as const;

/**
 * Return a human-readable identifier for this build, e.g. `tenantforge@0.3.0`.
 *
 * @returns The `id@version` string.
 */
export function buildId(): string {
  return `${TENANTFORGE.id}@${TENANTFORGE.version}`;
}
