import type { Vector } from '../../core/domain.js';

/**
 * Serialize a vector to the pgvector text literal form, e.g. `[1,2,3]`.
 *
 * Used as a bound query parameter cast to `::vector` — never string-interpolated into SQL.
 *
 * @param vector - The vector to serialize.
 * @returns The pgvector literal.
 */
export function formatVector(vector: Vector): string {
  return `[${vector.join(',')}]`;
}

/**
 * Parse a pgvector text literal (`[1,2,3]`) back into a numeric vector.
 *
 * @param literal - The pgvector literal as returned by Postgres.
 * @returns The parsed vector.
 * @throws Error if the literal is malformed or has a non-numeric component.
 */
export function parseVector(literal: string): Vector {
  const trimmed = literal.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    throw new Error(`invalid pgvector literal: ${literal}`);
  }
  const inner = trimmed.slice(1, -1).trim();
  if (inner.length === 0) return [];
  return inner.split(',').map((part) => {
    const value = Number(part);
    if (Number.isNaN(value)) {
      throw new Error(`invalid vector component: ${part}`);
    }
    return value;
  });
}
