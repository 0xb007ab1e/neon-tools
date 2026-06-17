/** Matches a canonical UUID (any version), case-insensitive. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a string is a canonical UUID.
 *
 * Used to guard model ids before they are interpolated into index DDL (which cannot be
 * parameterized), so an id can never carry SQL.
 *
 * @param value - The candidate id.
 * @returns True if `value` is a UUID.
 */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
