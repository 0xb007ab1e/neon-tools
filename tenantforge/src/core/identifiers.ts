/** Matches a canonical UUID (any version), case-insensitive. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A valid tenant slug: lowercase alphanumerics in hyphen-separated groups, 3–63 chars. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Minimum slug length. */
const SLUG_MIN = 3;
/** Maximum slug length (DNS-label-safe, leaving room for a Neon project-name prefix). */
const SLUG_MAX = 63;

/**
 * Slugs reserved for the control plane itself — never assignable to a tenant. Guards against a
 * tenant slug colliding with internal routes/identifiers.
 */
const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'admin',
  'api',
  'internal',
  'system',
  'tenantforge',
  'public',
]);

/**
 * Whether a string is a canonical UUID.
 *
 * Tenant and migration ids are UUIDs; this guards an id's shape before it is used as a lookup key
 * or interpolated anywhere it must not carry arbitrary text.
 *
 * @param value - The candidate id.
 * @returns True if `value` is a UUID.
 */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Normalize a candidate slug: trim surrounding whitespace and lowercase it.
 *
 * Normalization is deliberately conservative — it does not strip or substitute invalid characters,
 * so a malformed slug stays malformed and is rejected by {@link isValidSlug} rather than silently
 * mangled into a different tenant's slug.
 *
 * @param value - The raw slug input.
 * @returns The normalized slug.
 */
export function normalizeSlug(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Whether a (already-normalized) slug is valid and assignable to a tenant.
 *
 * The slug becomes part of the Neon project name and is the human-facing routing key, so it must be
 * DNS-label-safe, length-bounded, and not collide with a reserved control-plane name.
 *
 * @param value - The candidate slug (normalize with {@link normalizeSlug} first).
 * @returns True if the slug is well-formed, in range, and not reserved.
 */
export function isValidSlug(value: string): boolean {
  if (value.length < SLUG_MIN || value.length > SLUG_MAX) return false;
  if (!SLUG_RE.test(value)) return false;
  if (RESERVED_SLUGS.has(value)) return false;
  return true;
}

/**
 * Normalize and validate a slug, returning the normalized value or throwing.
 *
 * @param value - The raw slug input.
 * @returns The normalized, validated slug.
 * @throws Error if the slug is empty, out of the 3–63 range, malformed, or reserved.
 */
export function assertSlug(value: string): string {
  const slug = normalizeSlug(value);
  if (!isValidSlug(slug)) {
    throw new Error(
      `invalid tenant slug ${JSON.stringify(value)}: must be 3–63 chars, lowercase ` +
        `alphanumerics separated by single hyphens, and not a reserved name`,
    );
  }
  return slug;
}
