/**
 * Static build metadata for the VectorNest tool.
 *
 * Kept dependency-free so any entrypoint (library / CLI / MCP) can report
 * identity without pulling in adapters or I/O.
 */
export const VECTORNEST = {
  /** Stable tool id; matches `id` in neon-tool.json. */
  id: 'vectornest',
  /** Semantic version of this build. */
  version: '0.0.0',
} as const;

/**
 * Return a human-readable identifier for this build, e.g. `vectornest@0.0.0`.
 *
 * @returns The `id@version` string.
 */
export function buildId(): string {
  return `${VECTORNEST.id}@${VECTORNEST.version}`;
}
